/**
 * AI Proctoring Engine
 * Monitors webcam, microphone, screen sharing, window activity, and user inputs.
 */

export class ProctorEngine {
    constructor(callbacks = {}) {
        this.callbacks = {
            onViolation: callbacks.onViolation || (() => {}),
            onVolumeChange: callbacks.onVolumeChange || (() => {}),
            onModelLoaded: callbacks.onModelLoaded || (() => {}),
            ...callbacks
        };

        // Streams and contexts
        this.webcamStream = null;
        this.screenStream = null;
        this.audioCtx = null;
        this.analyser = null;
        this.audioInterval = null;
        
        // AI model
        this.cocoModel = null;
        this.aiInterval = null;

        // Restriction state variables
        this.isFullscreenActive = false;
        this.isMonitoring = false;
        this.isAiRunning = false;

        // Bound event listeners for proper removal
        this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
        this.handleWindowBlur = this.handleWindowBlur.bind(this);
        this.handleFullscreenChange = this.handleFullscreenChange.bind(this);
        this.handleMouseLeave = this.handleMouseLeave.bind(this);
        this.handleKeydown = this.handleKeydown.bind(this);
        this.handleContextMenu = this.handleContextMenu.bind(this);
    }

    /**
     * Load TensorFlow COCO-SSD object detection model
     */
    async loadModel() {
        try {
            // Wait for CDN script tags to load and expose window.cocoSsd
            let attempts = 0;
            while (!window.cocoSsd && attempts < 50) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }

            if (!window.cocoSsd) {
                throw new Error("TensorFlow COCO-SSD scripts could not be loaded from CDN.");
            }

            this.cocoModel = await window.cocoSsd.load({
                base: 'lite_mobilenet_v2' // Load lightweight model for faster mobile/browser inference
            });
            
            this.callbacks.onModelLoaded(true);
            return true;
        } catch (error) {
            console.error("AI Model Loading Error: ", error);
            this.callbacks.onModelLoaded(false, error.message);
            return false;
        }
    }

    /**
     * Request webcam and audio access, and display webcam stream in video element
     */
    async requestMediaAccess(videoElement) {
        try {
            this.webcamStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 480 },
                    facingMode: "user"
                },
                audio: true
            });

            if (videoElement) {
                videoElement.srcObject = this.webcamStream;
                videoElement.onloadedmetadata = () => {
                    videoElement.play();
                };
            }

            this.setupAudioAnalysis();
            return true;
        } catch (error) {
            console.error("Hardware Permission Denied: ", error);
            throw new Error("Webcam/Microphone permissions were denied. Both are required for proctoring.");
        }
    }

    /**
     * Request screen sharing and verify user shared the entire screen
     */
    async requestScreenShare() {
        try {
            this.screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    cursor: "always"
                },
                audio: false
            });

            const videoTrack = this.screenStream.getVideoTracks()[0];
            const settings = videoTrack.getSettings();

            // Check if user shared the ENTIRE desktop (monitor) or just a single tab/window
            if (settings.displaySurface && settings.displaySurface !== 'monitor') {
                this.stopScreenStream();
                throw new Error("Multiple screen/window sharing is restricted. You must share your ENTIRE screen to proceed.");
            }

            // Listen if screen sharing is stopped during the exam
            videoTrack.onended = () => {
                if (this.isMonitoring) {
                    this.callbacks.onViolation(
                        'screen_stopped', 
                        'Screen sharing was terminated by the user. Exam locked.', 
                        'critical'
                    );
                }
            };

            return true;
        } catch (error) {
            console.error("Screen Share Access Error: ", error);
            throw new Error(error.message || "Screen sharing access was denied or cancelled.");
        }
    }

    /**
     * Setup audio analysis using Web Audio API to detect microphone volume level
     */
    setupAudioAnalysis() {
        if (!this.webcamStream) return;

        try {
            const audioTrack = this.webcamStream.getAudioTracks()[0];
            if (!audioTrack) return;

            // Create AudioContext
            this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const source = this.audioCtx.createMediaStreamSource(new MediaStream([audioTrack]));
            
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 256;
            source.connect(this.analyser);

            const bufferLength = this.analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);

            let highVolumeDuration = 0;

            this.audioInterval = setInterval(() => {
                if (!this.analyser) return;

                this.analyser.getByteTimeDomainData(dataArray);

                // Calculate Root Mean Square (RMS) of audio amplitude
                let sum = 0;
                for (let i = 0; i < bufferLength; i++) {
                    const val = (dataArray[i] - 128) / 128;
                    sum += val * val;
                }
                const rms = Math.sqrt(sum / bufferLength);
                
                // Scale output to 0-100%
                const volumePercent = Math.min(Math.round(rms * 400), 100);
                this.callbacks.onVolumeChange(volumePercent);

                // Threshold logic: check if speaking levels (rms > 0.15) persist for > 3 seconds
                if (this.isMonitoring && rms > 0.18) {
                    highVolumeDuration += 200; // Increment duration (checking every 200ms)
                    if (highVolumeDuration >= 3000) {
                        this.callbacks.onViolation('noise', 'Consistent vocal noise or audio activity detected.', 'warning');
                        highVolumeDuration = 0; // Reset threshold timer
                    }
                } else {
                    highVolumeDuration = Math.max(0, highVolumeDuration - 200);
                }
            }, 200);

        } catch (error) {
            console.error("Audio analyser initialization failed: ", error);
        }
    }

    /**
     * Starts background AI loop using TensorFlow.js COCO-SSD object detection
     */
    startAiMonitoring(videoElement, canvasElement) {
        if (!this.cocoModel || !videoElement || !canvasElement) return;

        const ctx = canvasElement.getContext('2d');
        canvasElement.width = videoElement.videoWidth || 640;
        canvasElement.height = videoElement.videoHeight || 480;

        this.isAiRunning = true;
        let absentFrames = 0;
        let phoneFrames = 0;

        const detectFrame = async () => {
            if (!this.isAiRunning) return;

            try {
                // Perform model detection
                const predictions = await this.cocoModel.detect(videoElement);
                
                // Clear previous bounding boxes
                ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);

                let personCount = 0;
                let cellPhoneDetected = false;

                // Process predictions
                predictions.forEach(prediction => {
                    const [x, y, width, height] = prediction.bbox;
                    const className = prediction.class;
                    const confidence = Math.round(prediction.score * 100);

                    // Draw bounding boxes on canvas for visually impressive feedback
                    if (className === 'person' || className === 'cell phone') {
                        const isViolating = className === 'cell phone';
                        ctx.strokeStyle = isViolating ? '#ff0055' : '#00ff87';
                        ctx.lineWidth = 3;
                        ctx.strokeRect(x, y, width, height);

                        ctx.fillStyle = isViolating ? '#ff0055' : '#00ff87';
                        ctx.font = 'bold 12px sans-serif';
                        ctx.fillText(`${className.toUpperCase()} (${confidence}%)`, x + 5, y > 15 ? y - 5 : y + 15);
                    }

                    if (className === 'person') {
                        personCount++;
                    }
                    if (className === 'cell phone') {
                        cellPhoneDetected = true;
                    }
                });

                // Rule evaluations
                if (this.isMonitoring) {
                    // 1. Multiple people detection
                    if (personCount > 1) {
                        this.callbacks.onViolation(
                            'multiple_people', 
                            `Multiple people (${personCount}) detected in video feed.`, 
                            'warning'
                        );
                    }
                    
                    // 2. Candidate absence detection
                    if (personCount === 0) {
                        absentFrames++;
                        if (absentFrames >= 3) { // User has been absent for ~4.5 seconds
                            this.callbacks.onViolation(
                                'no_person', 
                                'No candidate detected in webcam view. Please face the camera.', 
                                'warning'
                            );
                            absentFrames = 0;
                        }
                    } else {
                        absentFrames = 0;
                    }

                    // 3. Cell phone detection (instant/fast trigger)
                    if (cellPhoneDetected) {
                        phoneFrames++;
                        if (phoneFrames >= 2) { // Phone visible for 2 consecutive evaluations
                            this.callbacks.onViolation(
                                'cell_phone', 
                                'Electronic device (mobile phone) detected in frame.', 
                                'critical'
                            );
                            phoneFrames = 0;
                        }
                    } else {
                        phoneFrames = 0;
                    }
                }

            } catch (err) {
                console.error("AI detection frame evaluation error: ", err);
            }

            // Schedule next frame check in 1.5 seconds to save resources
            this.aiInterval = setTimeout(detectFrame, 1500);
        };

        detectFrame();
    }

    /**
     * Setup environment constraints and boundary event listeners
     */
    startEnvironmentMonitoring() {
        this.isMonitoring = true;

        // Register window blur & visibility tracking
        document.addEventListener('visibilitychange', this.handleVisibilityChange);
        window.addEventListener('blur', this.handleWindowBlur);
        
        // Fullscreen tracking
        document.addEventListener('fullscreenchange', this.handleFullscreenChange);
        
        // Mouse coordinate tracking
        document.addEventListener('mouseleave', this.handleMouseLeave);

        // Inputs restrictions (blocks copy, paste, right-click, F12)
        document.addEventListener('keydown', this.handleKeydown);
        document.addEventListener('contextmenu', this.handleContextMenu);
    }

    /**
     * Remove all restrictions and stop monitoring
     */
    stopEnvironmentMonitoring() {
        this.isMonitoring = false;

        document.removeEventListener('visibilitychange', this.handleVisibilityChange);
        window.removeEventListener('blur', this.handleWindowBlur);
        document.removeEventListener('fullscreenchange', this.handleFullscreenChange);
        document.removeEventListener('mouseleave', this.handleMouseLeave);
        document.removeEventListener('keydown', this.handleKeydown);
        document.removeEventListener('contextmenu', this.handleContextMenu);
    }

    /* ================= INDIVIDUAL EVENT HANDLERS ================= */

    handleVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            this.callbacks.onViolation(
                'tab_switch', 
                'Navigation event: Candidate switched browser tab or minimized window.', 
                'warning'
            );
        }
    }

    handleWindowBlur() {
        this.callbacks.onViolation(
            'window_blur', 
            'Focus lost: Candidate clicked outside of the secure exam boundary.', 
            'warning'
        );
    }

    handleFullscreenChange() {
        if (!document.fullscreenElement) {
            this.callbacks.onViolation(
                'fullscreen_exit', 
                'Exam layout exited secure fullscreen mode. Fullscreen required.', 
                'warning'
            );
        }
    }

    handleMouseLeave() {
        this.callbacks.onViolation(
            'mouse_leave', 
            'Cursor boundaries crossed: Mouse moved outside the exam browser pane.', 
            'warning'
        );
    }

    handleKeydown(e) {
        // Block Copy, Paste, Cut — candidates cannot copy exam questions
        if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'v' || e.key === 'x')) {
            e.preventDefault();
            return false;
        }

        // Block Source Inspection combinations
        if (e.key === 'F12' || 
            ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C')) || 
            ((e.ctrlKey || e.metaKey) && e.key === 'u')) {
            e.preventDefault();
            this.callbacks.onViolation('keyboard_block', 'Developer inspecting keys blocked (Source views restricted).', 'warning');
            return false;
        }
    }

    handleContextMenu(e) {
        e.preventDefault();
        this.callbacks.onViolation('context_menu', 'Right click blocked (context menu restricted).', 'warning');
        return false;
    }

    /* ================= CLEANUP AND SHUTDOWN ================= */

    stopAllStreams() {
        this.stopEnvironmentMonitoring();
        
        this.isAiRunning = false;
        if (this.aiInterval) clearTimeout(this.aiInterval);
        if (this.audioInterval) clearInterval(this.audioInterval);

        this.stopWebcamStream();
        this.stopScreenStream();

        if (this.audioCtx && this.audioCtx.state !== 'closed') {
            this.audioCtx.close();
        }
    }

    stopWebcamStream() {
        if (this.webcamStream) {
            this.webcamStream.getTracks().forEach(track => track.stop());
            this.webcamStream = null;
        }
    }

    stopScreenStream() {
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(track => track.stop());
            this.screenStream = null;
        }
    }
}
