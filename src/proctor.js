/**
 * AI Proctoring Engine v2
 * Monitors webcam, microphone, screen sharing, window activity, user inputs,
 * eye gaze direction, and screenshot prevention.
 */

export class ProctorEngine {
    constructor(callbacks = {}) {
        this.callbacks = {
            onViolation: callbacks.onViolation || (() => {}),
            onVolumeChange: callbacks.onVolumeChange || (() => {}),
            onModelLoaded: callbacks.onModelLoaded || (() => {}),
            onGazeUpdate: callbacks.onGazeUpdate || (() => {}),
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

        // Gaze tracking state
        this.gazeOffFrames = 0;
        this.gazeInterval = null;
        this.lastGazeStatus = 'center';

        // Bound event listeners for proper removal
        this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
        this.handleWindowBlur = this.handleWindowBlur.bind(this);
        this.handleFullscreenChange = this.handleFullscreenChange.bind(this);
        this.handleMouseLeave = this.handleMouseLeave.bind(this);
        this.handleKeydown = this.handleKeydown.bind(this);
        this.handleContextMenu = this.handleContextMenu.bind(this);
        this.handleScreenshotKey = this.handleScreenshotKey.bind(this);
        this.handlePrintScreen = this.handlePrintScreen.bind(this);
        this.handleCopy = this.handleCopy.bind(this);
    }

    /**
     * Load TensorFlow COCO-SSD object detection model
     */
    async loadModel() {
        try {
            let attempts = 0;
            while (!window.cocoSsd && attempts < 50) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }

            if (!window.cocoSsd) {
                throw new Error("TensorFlow COCO-SSD scripts could not be loaded from CDN.");
            }

            this.cocoModel = await window.cocoSsd.load({
                base: 'lite_mobilenet_v2'
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
                video: { cursor: "always" },
                audio: false
            });

            const videoTrack = this.screenStream.getVideoTracks()[0];
            const settings = videoTrack.getSettings();

            if (settings.displaySurface && settings.displaySurface !== 'monitor') {
                this.stopScreenStream();
                throw new Error("Multiple screen/window sharing is restricted. You must share your ENTIRE screen to proceed.");
            }

            videoTrack.onended = () => {
                if (this.isMonitoring) {
                    this.callbacks.onViolation(
                        'screen_stopped',
                        'Screen sharing was terminated by the user.',
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

                let sum = 0;
                for (let i = 0; i < bufferLength; i++) {
                    const val = (dataArray[i] - 128) / 128;
                    sum += val * val;
                }
                const rms = Math.sqrt(sum / bufferLength);
                const volumePercent = Math.min(Math.round(rms * 400), 100);
                this.callbacks.onVolumeChange(volumePercent);

                if (this.isMonitoring && rms > 0.18) {
                    highVolumeDuration += 200;
                    if (highVolumeDuration >= 3000) {
                        this.callbacks.onViolation('noise', 'Consistent vocal noise detected near microphone.', 'warning');
                        highVolumeDuration = 0;
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
     * Estimate eye gaze direction based on face landmark positions in the video frame.
     * Uses pixel analysis on a small canvas to detect iris position relative to eye region.
     */
    startGazeTracking(videoElement) {
        const gazeCanvas = document.createElement('canvas');
        gazeCanvas.width = 160;
        gazeCanvas.height = 120;
        const gazeCtx = gazeCanvas.getContext('2d', { willReadFrequently: true });

        let consecutiveOffGaze = 0;

        this.gazeInterval = setInterval(() => {
            if (!this.isMonitoring || !videoElement || videoElement.readyState < 2) return;

            try {
                // Draw scaled-down frame for fast analysis
                gazeCtx.drawImage(videoElement, 0, 0, 160, 120);
                const imageData = gazeCtx.getImageData(0, 0, 160, 120);
                const data = imageData.data;

                // Analyze upper-center region (forehead/eye zone: y 20-55, x 30-130)
                let darkPixelX = 0;
                let darkPixelCount = 0;
                let totalPixelCount = 0;
                
                const eyeYStart = 20, eyeYEnd = 55;
                const eyeXStart = 30, eyeXEnd = 130;

                for (let y = eyeYStart; y < eyeYEnd; y++) {
                    for (let x = eyeXStart; x < eyeXEnd; x++) {
                        const idx = (y * 160 + x) * 4;
                        const r = data[idx];
                        const g = data[idx + 1];
                        const b = data[idx + 2];
                        const brightness = (r + g + b) / 3;
                        totalPixelCount++;

                        // Dark pixels likely represent iris/pupil regions
                        if (brightness < 70) {
                            darkPixelX += x;
                            darkPixelCount++;
                        }
                    }
                }

                if (darkPixelCount < 5) {
                    // Not enough dark pixels — face likely not visible or turned far away
                    consecutiveOffGaze++;
                    if (consecutiveOffGaze >= 4) {
                        this.callbacks.onGazeUpdate('away', 'Face not detected — candidate may have looked away.');
                        if (consecutiveOffGaze === 4 || consecutiveOffGaze % 8 === 0) {
                            this.callbacks.onViolation('gaze_away', 'Eyes not focused on screen — candidate may be looking away.', 'warning');
                        }
                    }
                    return;
                }

                const avgDarkX = darkPixelX / darkPixelCount;
                const centerX = (eyeXStart + eyeXEnd) / 2;
                const deviation = avgDarkX - centerX;

                let gazeStatus;
                if (Math.abs(deviation) < 15) {
                    gazeStatus = 'center';
                    consecutiveOffGaze = 0;
                } else if (deviation < -15) {
                    gazeStatus = 'left';
                    consecutiveOffGaze++;
                } else {
                    gazeStatus = 'right';
                    consecutiveOffGaze++;
                }

                this.callbacks.onGazeUpdate(gazeStatus, null);

                // Fire violation after looking away for ~3 seconds (6 intervals × 500ms)
                if (consecutiveOffGaze >= 6 && (gazeStatus === 'left' || gazeStatus === 'right')) {
                    if (consecutiveOffGaze === 6 || consecutiveOffGaze % 12 === 0) {
                        this.callbacks.onViolation(
                            'gaze_away',
                            `Eyes detected looking ${gazeStatus} — candidate may be reading from an external source.`,
                            'warning'
                        );
                    }
                }

                this.lastGazeStatus = gazeStatus;

            } catch (err) {
                // Silently continue if frame analysis fails
            }
        }, 500);
    }

    /**
     * Starts background AI loop using TensorFlow.js COCO-SSD object detection
     */
    startAiMonitoring(videoElement, canvasElement) {
        if (!this.cocoModel || !videoElement || !canvasElement) return;

        const ctx = canvasElement.getContext('2d');
        canvasElement.width = videoElement.videoWidth || 320;
        canvasElement.height = videoElement.videoHeight || 240;

        this.isAiRunning = true;
        let absentFrames = 0;
        let phoneFrames = 0;

        const detectFrame = async () => {
            if (!this.isAiRunning) return;

            try {
                const predictions = await this.cocoModel.detect(videoElement);

                ctx.clearRect(0, 0, canvasElement.width, canvasElement.height);

                let personCount = 0;
                let cellPhoneDetected = false;

                predictions.forEach(prediction => {
                    const [x, y, width, height] = prediction.bbox;
                    const className = prediction.class;
                    const confidence = Math.round(prediction.score * 100);

                    if (className === 'person' || className === 'cell phone') {
                        const isViolating = className === 'cell phone';
                        ctx.strokeStyle = isViolating ? '#ff0055' : '#00ff87';
                        ctx.lineWidth = 2;
                        ctx.strokeRect(x, y, width, height);

                        ctx.fillStyle = isViolating ? '#ff0055' : '#00ff87';
                        ctx.font = 'bold 10px sans-serif';
                        ctx.fillText(`${className.toUpperCase()} (${confidence}%)`, x + 4, y > 15 ? y - 4 : y + 12);
                    }

                    if (className === 'person') personCount++;
                    if (className === 'cell phone') cellPhoneDetected = true;
                });

                if (this.isMonitoring) {
                    if (personCount > 1) {
                        this.callbacks.onViolation(
                            'multiple_people',
                            `Multiple people (${personCount}) detected in video feed.`,
                            'warning'
                        );
                    }

                    if (personCount === 0) {
                        absentFrames++;
                        if (absentFrames >= 3) {
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

                    if (cellPhoneDetected) {
                        phoneFrames++;
                        if (phoneFrames >= 2) {
                            this.callbacks.onViolation(
                                'cell_phone',
                                'Mobile phone detected in camera frame.',
                                'warning'
                            );
                            phoneFrames = 0;
                        }
                    } else {
                        phoneFrames = 0;
                    }
                }

            } catch (err) {
                console.error("AI detection error: ", err);
            }

            this.aiInterval = setTimeout(detectFrame, 1500);
        };

        detectFrame();

        // Also start gaze tracking
        this.startGazeTracking(videoElement);
    }

    /**
     * Setup environment constraints and boundary event listeners
     */
    startEnvironmentMonitoring() {
        this.isMonitoring = true;

        document.addEventListener('visibilitychange', this.handleVisibilityChange);
        window.addEventListener('blur', this.handleWindowBlur);
        document.addEventListener('fullscreenchange', this.handleFullscreenChange);
        document.addEventListener('mouseleave', this.handleMouseLeave);
        document.addEventListener('keydown', this.handleKeydown);
        document.addEventListener('contextmenu', this.handleContextMenu);

        // Screenshot prevention
        document.addEventListener('keyup', this.handleScreenshotKey);
        window.addEventListener('beforeprint', this.handlePrintScreen);
        document.addEventListener('copy', this.handleCopy);
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
        document.removeEventListener('keyup', this.handleScreenshotKey);
        window.removeEventListener('beforeprint', this.handlePrintScreen);
        document.removeEventListener('copy', this.handleCopy);

        if (this.gazeInterval) {
            clearInterval(this.gazeInterval);
            this.gazeInterval = null;
        }
    }

    /* ================= INDIVIDUAL EVENT HANDLERS ================= */

    handleVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            this.callbacks.onViolation(
                'tab_switch',
                'Candidate switched browser tab or minimized window.',
                'warning'
            );
        }
    }

    handleWindowBlur() {
        this.callbacks.onViolation(
            'window_blur',
            'Focus lost — candidate clicked outside of the secure exam window.',
            'warning'
        );
    }

    handleFullscreenChange() {
        if (!document.fullscreenElement) {
            this.callbacks.onViolation(
                'fullscreen_exit',
                'Exam exited fullscreen mode — fullscreen is required during exam.',
                'warning'
            );
        }
    }

    handleMouseLeave() {
        this.callbacks.onViolation(
            'mouse_leave',
            'Mouse cursor moved outside the exam browser window boundary.',
            'warning'
        );
    }

    handleKeydown(e) {
        // Block Copy, Paste, Cut
        if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'v' || e.key === 'x')) {
            e.preventDefault();
            this.callbacks.onViolation('copy_paste', 'Copy/Cut/Paste keyboard shortcut blocked.', 'warning');
            return false;
        }

        // Block Dev Tools
        if (e.key === 'F12' ||
            ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'I' || e.key === 'J' || e.key === 'C')) ||
            ((e.ctrlKey || e.metaKey) && e.key === 'u')) {
            e.preventDefault();
            this.callbacks.onViolation('devtools', 'Developer tools access attempt blocked.', 'warning');
            return false;
        }

        // Block Print Screen / screenshot keys
        if (e.key === 'PrintScreen' || e.key === 'Snapshot') {
            e.preventDefault();
            // Clear clipboard immediately
            navigator.clipboard?.writeText('').catch(() => {});
            this.callbacks.onViolation('screenshot', 'Screenshot attempt detected and blocked (PrintScreen key).', 'warning');
            return false;
        }

        // Block Windows Snipping Tool (Win+Shift+S)
        if (e.key === 'S' && e.shiftKey && e.metaKey) {
            e.preventDefault();
            this.callbacks.onViolation('screenshot', 'Screenshot shortcut (Win+Shift+S) detected and blocked.', 'warning');
            return false;
        }

        // Block Alt+PrintScreen
        if (e.altKey && (e.key === 'PrintScreen' || e.key === 'Snapshot')) {
            e.preventDefault();
            this.callbacks.onViolation('screenshot', 'Alt+PrintScreen screenshot attempt blocked.', 'warning');
            return false;
        }
    }

    handleScreenshotKey(e) {
        // On keyup: if PrintScreen was pressed, clear clipboard
        if (e.key === 'PrintScreen' || e.key === 'Snapshot') {
            navigator.clipboard?.writeText('⚠️ Screenshot blocked by exam security system').catch(() => {});
        }
    }

    handlePrintScreen() {
        // Block browser print dialog (also used for screenshot-to-PDF)
        window.print = () => {};
        this.callbacks.onViolation('screenshot', 'Print/screenshot via browser print dialog was blocked.', 'warning');
    }

    handleContextMenu(e) {
        e.preventDefault();
        return false;
    }

    handleCopy(e) {
        e.preventDefault();
        if (e.clipboardData) {
            e.clipboardData.setData('text/plain', '');
        }
        return false;
    }

    /* ================= CLEANUP AND SHUTDOWN ================= */

    stopAllStreams() {
        this.stopEnvironmentMonitoring();

        this.isAiRunning = false;
        if (this.aiInterval) clearTimeout(this.aiInterval);
        if (this.audioInterval) clearInterval(this.audioInterval);
        if (this.gazeInterval) clearInterval(this.gazeInterval);

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
