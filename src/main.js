import { questions as defaultQuestions } from './questions.js';
import { ProctorEngine } from './proctor.js';

// Application State
let activeQuestions = [];
let currentQuestionIndex = 0;
const answers = {}; // Maps questionIndex -> selectedOptionIndex (or text response)
let warnings = 0;
const maxWarnings = 3;
let timeLeft = 2700; // 45 minutes in seconds
let timerInterval = null;
const violationLogs = [];

// Load questions from local storage or fallback to defaults
function loadActiveQuestions() {
    const stored = localStorage.getItem('proctor_exam_questions');
    if (stored) {
        try {
            activeQuestions = JSON.parse(stored);
        } catch (e) {
            console.error("Failed to parse stored questions, falling back to defaults.", e);
            activeQuestions = JSON.parse(JSON.stringify(defaultQuestions));
        }
    } else {
        activeQuestions = JSON.parse(JSON.stringify(defaultQuestions));
    }
}

// DOM Elements
const views = {
    setup: document.getElementById('setup-view'),
    exam: document.getElementById('exam-view'),
    blocked: document.getElementById('blocked-view'),
    success: document.getElementById('success-view')
};

const checklist = {
    model: document.getElementById('check-model'),
    camera: document.getElementById('check-camera'),
    mic: document.getElementById('check-mic'),
    screen: document.getElementById('check-screen'),
    fullscreen: document.getElementById('check-fullscreen')
};

const btns = {
    requestPerms: document.getElementById('btn-request-perms'),
    startExam: document.getElementById('btn-start-exam'),
    prev: document.getElementById('btn-prev'),
    skip: document.getElementById('btn-skip'),
    next: document.getElementById('btn-next'),
    submit: document.getElementById('btn-submit')
};

const media = {
    setupWebcam: document.getElementById('setup-webcam'),
    setupMicMeter: document.getElementById('setup-mic-meter'),
    examWebcam: document.getElementById('exam-webcam'),
    examCanvas: document.getElementById('exam-canvas')
};

const indicators = {
    violationCount: document.getElementById('violation-count'),
    violationBar: document.getElementById('violation-bar'),
    audioDb: document.getElementById('audio-db'),
    audioBar: document.getElementById('audio-bar'),
    proctorLogs: document.getElementById('proctor-logs'),
    timer: document.getElementById('exam-timer'),
    proctorStatus: document.getElementById('proctor-status-text'),
    proctorDot: document.querySelector('.pulse-dot')
};

const questionView = {
    number: document.getElementById('question-number'),
    type: document.getElementById('question-type'),
    text: document.getElementById('question-text'),
    options: document.getElementById('question-options'),
    grid: document.getElementById('question-grid')
};

// State trackers for permissions
let isModelReady = false;
let isHardwareReady = false;
let isScreenReady = false;

// Instantiate the Proctor Engine
const proctor = new ProctorEngine({
    onModelLoaded: (success, errMsg) => {
        if (success) {
            isModelReady = true;
            updateChecklistItem(checklist.model, 'success', 'AI Proctoring Models initialized');
            enableStartIfReady();
        } else {
            updateChecklistItem(checklist.model, 'failed', `AI Models failed to load: ${errMsg}`);
        }
    },
    onVolumeChange: (volumePercent) => {
        if (views.setup.classList.contains('active')) {
            media.setupMicMeter.style.width = `${volumePercent}%`;
        } else if (views.exam.classList.contains('active')) {
            indicators.audioDb.textContent = `${volumePercent}%`;
            indicators.audioBar.style.width = `${volumePercent}%`;
            // Color feedback for levels
            if (volumePercent > 60) {
                indicators.audioBar.style.backgroundColor = '#ef4444';
            } else if (volumePercent > 35) {
                indicators.audioBar.style.backgroundColor = '#f59e0b';
            } else {
                indicators.audioBar.style.backgroundColor = '#4f7ef8';
            }
        }
    },
    onViolation: (type, message, severity) => {
        handleProctorViolation(type, message, severity);
    }
});

/**
 * Update the visual status of checklist elements
 */
function updateChecklistItem(item, status, text) {
    if (!item) return;
    item.className = `check-item ${status}`;
    const icon = item.querySelector('.status-icon');
    const label = item.querySelector('.status-text');
    
    if (status === 'success') {
        icon.textContent = '✓';
    } else if (status === 'failed') {
        icon.textContent = '❌';
    } else if (status === 'pending') {
        icon.textContent = '⏳';
    }
    
    if (text) label.textContent = text;
}

/**
 * Evaluate if Start Exam button should be enabled
 */
function enableStartIfReady() {
    if (isModelReady && isHardwareReady && isScreenReady) {
        btns.startExam.disabled = false;
    }
}

/**
 * Handle proctoring warnings and violations
 */
function handleProctorViolation(type, message, severity) {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[${timestamp}] [Warning] ${message}`;
    
    violationLogs.push({ time: timestamp, type, message, severity });

    const logElement = document.createElement('div');
    logElement.className = `log-entry ${severity === 'critical' ? 'danger' : 'warning'}`;
    logElement.textContent = logMessage;
    
    indicators.proctorLogs.appendChild(logElement);
    indicators.proctorLogs.scrollTop = indicators.proctorLogs.scrollHeight;

    // Flash screen red temporarily on violation
    document.body.style.boxShadow = 'inset 0 0 40px rgba(239, 68, 68, 0.25)';
    setTimeout(() => {
        document.body.style.boxShadow = 'none';
    }, 800);

    // Skip warning count for minor keyboard/menu blocks
    if (type === 'keyboard_block' || type === 'context_menu') {
        return; 
    }

    if (severity === 'critical') {
        triggerLockout(`Critical boundary breached: ${message}`);
    } else {
        warnings++;
        updateViolationGauge();
        
        if (warnings >= maxWarnings) {
            triggerLockout('Maximum cheating warnings exceeded.');
        }
    }
}

/**
 * Update the UI gauge for warning counts
 */
function updateViolationGauge() {
    indicators.violationCount.textContent = `${warnings} / ${maxWarnings}`;
    const fillPercent = (warnings / maxWarnings) * 100;
    indicators.violationBar.style.width = `${fillPercent}%`;
}

/**
 * Launch full screen mode request
 */
async function enterFullscreen() {
    const docEl = document.documentElement;
    try {
        if (docEl.requestFullscreen) {
            await docEl.requestFullscreen();
        } else if (docEl.webkitRequestFullscreen) {
            await docEl.webkitRequestFullscreen();
        } else if (docEl.msRequestFullscreen) {
            await docEl.msRequestFullscreen();
        }
        updateChecklistItem(checklist.fullscreen, 'success', 'Fullscreen mode locked');
        return true;
    } catch (err) {
        console.error("Fullscreen Request Failed: ", err);
        updateChecklistItem(checklist.fullscreen, 'failed', 'Fullscreen authorization failed');
        return false;
    }
}

/**
 * Request hardware stream permission and screen shares
 */
async function startVerificationCheck() {
    btns.requestPerms.disabled = true;
    
    // 1. Request Webcam and Audio
    try {
        updateChecklistItem(checklist.camera, 'pending', 'Connecting webcam...');
        updateChecklistItem(checklist.mic, 'pending', 'Connecting microphone...');
        
        await proctor.requestMediaAccess(media.setupWebcam);
        
        updateChecklistItem(checklist.camera, 'success', 'Webcam connection active');
        updateChecklistItem(checklist.mic, 'success', 'Microphone level active');
        isHardwareReady = true;
    } catch (err) {
        updateChecklistItem(checklist.camera, 'failed', err.message || 'Webcam permission denied');
        updateChecklistItem(checklist.mic, 'failed', err.message || 'Microphone permission denied');
        btns.requestPerms.disabled = false;
        return;
    }

    // 2. Request Screen Share
    try {
        updateChecklistItem(checklist.screen, 'pending', 'Awaiting screen selection...');
        await proctor.requestScreenShare();
        updateChecklistItem(checklist.screen, 'success', 'Entire screen share active');
        isScreenReady = true;
    } catch (err) {
        updateChecklistItem(checklist.screen, 'failed', err.message || 'Screen share denied');
        btns.requestPerms.disabled = false;
        return;
    }

    // 3. Request Fullscreen
    updateChecklistItem(checklist.fullscreen, 'pending', 'Awaiting fullscreen activation...');
    const fullscreenAllowed = await enterFullscreen();
    if (!fullscreenAllowed) {
        btns.requestPerms.disabled = false;
        return;
    }

    enableStartIfReady();
}

/**
 * Transition page view to the exam panel
 */
function launchExam() {
    proctor.stopWebcamStream();

    views.setup.classList.remove('active');
    views.exam.classList.add('active');

    // Transfer webcam feed to exam sidebar
    navigator.mediaDevices.getUserMedia({
        video: { width: 320, height: 240 },
        audio: false
    }).then(stream => {
        media.examWebcam.srcObject = stream;
        media.examWebcam.onloadedmetadata = () => {
            media.examWebcam.play();
            proctor.startAiMonitoring(media.examWebcam, media.examCanvas);
        };
    }).catch(() => {
        handleProctorViolation('webcam_transfer', 'Failed to transfer webcam stream to exam container.', 'critical');
    });

    proctor.startEnvironmentMonitoring();
    startTimer();
    buildQuestionGrid();
    loadQuestion(0);
}

/**
 * Handle timer interval ticks
 */
function startTimer() {
    timerInterval = setInterval(() => {
        timeLeft--;
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            finishExam(true);
        } else {
            const minutes = Math.floor(timeLeft / 60);
            const seconds = timeLeft % 60;
            indicators.timer.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            
            if (timeLeft < 300) {
                indicators.timer.style.color = '#ef4444';
            }
        }
    }, 1000);
}

/**
 * Generate navigation grid for questions drawer
 */
function buildQuestionGrid() {
    questionView.grid.innerHTML = '';
    activeQuestions.forEach((_, idx) => {
        const gridItem = document.createElement('div');
        gridItem.className = 'grid-item unvisited';
        gridItem.textContent = idx + 1;
        gridItem.id = `grid-q-${idx}`;
        gridItem.addEventListener('click', () => loadQuestion(idx));
        questionView.grid.appendChild(gridItem);
    });
}

/**
 * Render details of active question index
 */
function loadQuestion(index) {
    if (activeQuestions.length === 0) return;
    currentQuestionIndex = index;
    const q = activeQuestions[index];

    questionView.number.textContent = `Question ${index + 1} of ${activeQuestions.length}`;
    questionView.type.textContent = q.type === 'single' ? 'Multiple Choice' : 'Design / Written Proposal';
    questionView.text.textContent = q.text;

    questionView.options.innerHTML = '';
    if (q.type === 'single') {
        q.options.forEach((opt, optIdx) => {
            const optBtn = document.createElement('button');
            optBtn.className = 'option-btn';
            if (answers[index] === optIdx) {
                optBtn.classList.add('selected');
            }

            const letter = String.fromCharCode(65 + optIdx);
            optBtn.innerHTML = `
                <div class="option-marker">${letter}</div>
                <span>${opt}</span>
            `;

            optBtn.addEventListener('click', () => {
                document.querySelectorAll('.option-btn').forEach(btn => btn.classList.remove('selected'));
                optBtn.classList.add('selected');
                answers[index] = optIdx;
                updateQuestionStatus(index, 'answered');
            });

            questionView.options.appendChild(optBtn);
        });
    } else if (q.type === 'text') {
        const textInput = document.createElement('textarea');
        textInput.className = 'text-answer-input';
        textInput.placeholder = 'Type your technical solution here... (Minimum 50 words recommended)';
        textInput.value = answers[index] || '';

        textInput.addEventListener('input', (e) => {
            answers[index] = e.target.value;
            if (e.target.value.trim().length > 0) {
                updateQuestionStatus(index, 'answered');
            } else {
                updateQuestionStatus(index, 'unvisited');
            }
        });

        questionView.options.appendChild(textInput);
    }

    btns.prev.disabled = index === 0;
    if (index === activeQuestions.length - 1) {
        btns.next.style.display = 'none';
        btns.submit.style.display = 'inline-flex';
    } else {
        btns.next.style.display = 'inline-flex';
        btns.submit.style.display = 'none';
    }

    document.querySelectorAll('.grid-item').forEach(item => item.classList.remove('current'));
    const currentGridItem = document.getElementById(`grid-q-${index}`);
    if (currentGridItem) {
        currentGridItem.classList.add('current');
        if (currentGridItem.classList.contains('unvisited')) {
            currentGridItem.className = 'grid-item current';
        }
    }
}

/**
 * Update the state style of elements in the navigation grid
 */
function updateQuestionStatus(index, status) {
    const gridItem = document.getElementById(`grid-q-${index}`);
    if (gridItem) {
        gridItem.className = `grid-item ${status}`;
        if (index === currentQuestionIndex) {
            gridItem.classList.add('current');
        }
    }
}

/**
 * Handle next, prev, and skip buttons
 */
function handleNext() {
    if (currentQuestionIndex < activeQuestions.length - 1) {
        loadQuestion(currentQuestionIndex + 1);
    }
}

function handlePrev() {
    if (currentQuestionIndex > 0) {
        loadQuestion(currentQuestionIndex - 1);
    }
}

function handleSkip() {
    updateQuestionStatus(currentQuestionIndex, 'skipped');
    handleNext();
}

/**
 * Complete the exam and submit response payload
 */
function finishExam() {
    proctor.stopAllStreams();
    clearInterval(timerInterval);

    if (document.fullscreenElement) {
        document.exitFullscreen().catch(err => console.log(err));
    }

    views.exam.classList.remove('active');
    views.success.classList.add('active');
}

/**
 * Trigger secure lockout screen
 */
function triggerLockout(reason) {
    console.warn(`EXAM BLOCKED: ${reason}`);

    proctor.stopAllStreams();
    clearInterval(timerInterval);

    media.setupWebcam.srcObject = null;
    media.examWebcam.srcObject = null;

    if (document.fullscreenElement) {
        document.exitFullscreen().catch(err => console.log(err));
    }

    const sessionHashEl = document.getElementById('session-hash');
    const randomHash = Array.from({length: 24}, () => Math.floor(Math.random()*16).toString(16)).join('').toUpperCase();
    sessionHashEl.textContent = `SEC-ERR-${randomHash}`;

    const blockViolationList = document.getElementById('block-violation-list');
    blockViolationList.innerHTML = '';
    
    if (violationLogs.length === 0) {
        const item = document.createElement('li');
        item.textContent = `[${new Date().toLocaleTimeString()}] ${reason}`;
        blockViolationList.appendChild(item);
    } else {
        violationLogs.forEach(log => {
            const item = document.createElement('li');
            item.textContent = `[${log.time}] (${log.type.toUpperCase()}) ${log.message}`;
            blockViolationList.appendChild(item);
        });
    }

    Object.values(views).forEach(view => {
        if (view) view.classList.remove('active');
    });
    views.blocked.classList.add('active');
}

/* =========================================================================
   ========================= EVENT BINDINGS ================================
   ========================================================================= */

btns.requestPerms.addEventListener('click', startVerificationCheck);
btns.startExam.addEventListener('click', launchExam);
btns.next.addEventListener('click', handleNext);
btns.prev.addEventListener('click', handlePrev);
btns.skip.addEventListener('click', handleSkip);
btns.submit.addEventListener('click', finishExam);

// Initialize on page load — always show setup view directly
window.addEventListener('DOMContentLoaded', () => {

    // ── Mobile / Tablet Detection ──────────────────────────────────────────
    // Detect mobile via touch capability, screen width, AND user-agent
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i
        .test(navigator.userAgent)
        || (navigator.maxTouchPoints > 1 && window.innerWidth < 1024)
        || window.innerWidth < 768;

    if (isMobile) {
        document.getElementById('mobile-block-overlay').classList.add('active');
        // Stop everything — don't load exam at all on mobile
        return;
    }
    // ─────────────────────────────────────────────────────────────────────

    loadActiveQuestions();

    // Always show candidate setup view
    Object.values(views).forEach(view => {
        if (view) view.classList.remove('active');
    });
    views.setup.classList.add('active');

    updateChecklistItem(checklist.model, 'pending', 'Downloading TensorFlow model...');
    proctor.loadModel();
});
