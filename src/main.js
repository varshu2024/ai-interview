import { questions as defaultQuestions } from './questions.js';
import { ProctorEngine } from './proctor.js';
import {
    getAllStudents, upsertStudent, appendViolation, updateStudentStatus,
    isBlocked, blockStudent, getBlockedIds, getQuestions,
    generateSessionId, getMaxWarnings
} from './hr-data.js';

// ─── Session Identity ─────────────────────────────────────────────────────────
let sessionId = generateSessionId();
let studentName = 'Candidate';
let studentEmail = '';
let studentDomain = '';
let studentCollege = '';

// ─── Application State ────────────────────────────────────────────────────────
let activeQuestions = [];
let currentQuestionIndex = 0;
const answers = {};
let warnings = 0;
let maxWarnings = getMaxWarnings(); // default 4, configurable from HR portal
let timeLeft = 2700; // 45 minutes
let timerInterval = null;
const violationLogs = []; // Stores all violation events with timestamps

// Debounce map to avoid spamming the same violation type
const violationCooldowns = {};
const COOLDOWN_MS = {
    tab_switch: 4000,
    window_blur: 4000,
    mouse_leave: 8000,
    fullscreen_exit: 5000,
    noise: 6000,
    no_person: 6000,
    multiple_people: 8000,
    cell_phone: 6000,
    gaze_away: 5000,
    copy_paste: 3000,
    devtools: 3000,
    screenshot: 3000,
    keyboard_block: 2000,
    context_menu: 2000,
};

// Human-readable labels for violation types
const VIOLATION_LABELS = {
    tab_switch: '🔁 Tab Switch',
    window_blur: '🖱️ Window Focus Lost',
    mouse_leave: '↗️ Mouse Left Window',
    fullscreen_exit: '⛶ Fullscreen Exited',
    noise: '🔊 Loud Audio Detected',
    no_person: '👤 Face Not Visible',
    multiple_people: '👥 Multiple People',
    cell_phone: '📱 Phone Detected',
    gaze_away: '👁️ Eyes Off Screen',
    gaze_down: '👁️ Looking Down',
    copy_paste: '📋 Copy/Paste Blocked',
    devtools: '🛠️ DevTools Attempt',
    screenshot: '📸 Screenshot Blocked',
    keyboard_block: '⌨️ Key Blocked',
    context_menu: '🖱️ Right-Click Blocked',
    screen_stopped: '🖥️ Screen Share Stopped',
    webcam_transfer: '📷 Webcam Error',
};

// Load questions from local storage or fallback to defaults
function loadActiveQuestions() {
    const stored = getQuestions();
    if (stored && Array.isArray(stored) && stored.length > 0) {
        activeQuestions = JSON.parse(JSON.stringify(stored));
    } else {
        activeQuestions = JSON.parse(JSON.stringify(defaultQuestions));
    }
}

// ─── DOM Elements ─────────────────────────────────────────────────────────────
const views = {
    registration: document.getElementById('registration-view'),
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
    proctorDot: document.querySelector('.pulse-dot'),
    gazeStatus: document.getElementById('gaze-status'),
    gazeIndicator: document.getElementById('gaze-indicator')
};

const questionView = {
    number: document.getElementById('question-number'),
    type: document.getElementById('question-type'),
    text: document.getElementById('question-text'),
    options: document.getElementById('question-options'),
    grid: document.getElementById('question-grid')
};

// ─── Permission State ─────────────────────────────────────────────────────────
let isModelReady = false;
let isHardwareReady = false;
let isScreenReady = false;

// ─── Toast Notification System ───────────────────────────────────────────────
let toastContainer = null;

function ensureToastContainer() {
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toast-container';
        document.body.appendChild(toastContainer);
    }
    return toastContainer;
}

/**
 * Show a non-disruptive toast notification
 * @param {string} title - Short title
 * @param {string} message - Full message
 * @param {number} strikeNumber - Which strike this is (1, 2, or null)
 * @param {string} severity - 'info' | 'warning' | 'danger'
 */
function showToast(title, message, strikeNumber, severity = 'warning') {
    const container = ensureToastContainer();

    const toast = document.createElement('div');
    toast.className = `proctor-toast toast-${severity}`;

    const strikeHtml = strikeNumber ? `
        <div class="toast-strikes">
            ${Array.from({length: maxWarnings}, (_, i) =>
                `<span class="strike-dot ${i < strikeNumber ? 'filled' : ''}"></span>`
            ).join('')}
        </div>
    ` : '';

    const warningText = strikeNumber
        ? `Strike ${strikeNumber} of ${maxWarnings}`
        : '';

    toast.innerHTML = `
        <div class="toast-icon">${getViolationIcon(severity)}</div>
        <div class="toast-content">
            <div class="toast-header">
                <span class="toast-title">${title}</span>
                ${warningText ? `<span class="toast-strike-label">${warningText}</span>` : ''}
            </div>
            <p class="toast-message">${message}</p>
            ${strikeHtml}
            ${strikeNumber === maxWarnings - 1 ? '<p class="toast-final-warn">⚠️ One more violation = Access Revoked</p>' : ''}
        </div>
        <button class="toast-close" onclick="this.parentElement.remove()">✕</button>
    `;

    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        toast.classList.add('toast-visible');
    });

    // Auto-dismiss after 6 seconds
    setTimeout(() => {
        toast.classList.remove('toast-visible');
        toast.classList.add('toast-hiding');
        setTimeout(() => toast.remove(), 400);
    }, 6000);
}

function getViolationIcon(severity) {
    if (severity === 'danger') return '🚫';
    if (severity === 'warning') return '⚠️';
    return 'ℹ️';
}

// ─── ProctorEngine Instance ───────────────────────────────────────────────────
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
    },
    onGazeUpdate: (gazeStatus, message) => {
        updateGazeIndicator(gazeStatus);
    }
});

// ─── Gaze Indicator UI ────────────────────────────────────────────────────────
function updateGazeIndicator(gazeStatus) {
    if (!indicators.gazeStatus) return;

    const statusMap = {
        center: { label: '👁️ Looking at screen', cls: 'gaze-center' },
        left: { label: '👁️ Looking left', cls: 'gaze-left' },
        right: { label: '👁️ Looking right', cls: 'gaze-right' },
        down: { label: '👁️ Looking down', cls: 'gaze-down' },
        away: { label: '👁️ Face not detected', cls: 'gaze-away' },
    };

    const info = statusMap[gazeStatus] || statusMap.center;
    indicators.gazeStatus.textContent = info.label;

    if (indicators.gazeIndicator) {
        indicators.gazeIndicator.className = `gaze-indicator ${info.cls}`;
    }
}

// ─── Checklist UI Helper ──────────────────────────────────────────────────────
function updateChecklistItem(item, status, text) {
    if (!item) return;
    item.className = `check-item ${status}`;
    const icon = item.querySelector('.status-icon');
    const label = item.querySelector('.status-text');

    if (status === 'success') icon.textContent = '✓';
    else if (status === 'failed') icon.textContent = '❌';
    else if (status === 'pending') icon.textContent = '⏳';

    if (text) label.textContent = text;
}

function enableStartIfReady() {
    if (isModelReady && isHardwareReady && isScreenReady) {
        btns.startExam.disabled = false;
    }
}

function captureWebcamScreenshot() {
    try {
        const video = media.examWebcam;
        if (!video || video.readyState < 2) return null;
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 320;
        canvas.height = video.videoHeight || 240;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        
        // Add stamp for context
        ctx.fillStyle = 'rgba(239, 68, 68, 0.85)';
        ctx.font = 'bold 9px monospace';
        ctx.fillText(`VIOLATION STAMP - ${new Date().toLocaleTimeString()}`, 8, canvas.height - 8);
        
        return canvas.toDataURL('image/jpeg', 0.5); // high compression, low size
    } catch (e) {
        console.error('Webcam frame capture error:', e);
        return null;
    }
}

// ─── Core Violation Handler ───────────────────────────────────────────────────
function handleProctorViolation(type, message, severity) {
    // Debounce repeated violations of same type
    const cooldown = COOLDOWN_MS[type] || 3000;
    const now = Date.now();
    if (violationCooldowns[type] && now - violationCooldowns[type] < cooldown) {
        return; // Still in cooldown, skip
    }
    violationCooldowns[type] = now;

    const timestamp = new Date().toLocaleTimeString();

    // Add to proctor sidebar log
    const logElement = document.createElement('div');
    logElement.className = `log-entry ${severity === 'critical' ? 'danger' : 'warning'}`;
    logElement.textContent = `[${timestamp}] ${message}`;
    indicators.proctorLogs.appendChild(logElement);
    indicators.proctorLogs.scrollTop = indicators.proctorLogs.scrollHeight;

    // Flash screen border
    document.body.style.boxShadow = 'inset 0 0 60px rgba(239, 68, 68, 0.3)';
    setTimeout(() => { document.body.style.boxShadow = 'none'; }, 800);

    // Skip warning counts for passive blocks (right click / keyboard intercepts)
    if (type === 'keyboard_block' || type === 'context_menu') {
        return;
    }

    // ── Screenshot violations: log but don't count as strike ─────────────────
    if (type === 'screenshot') {
        violationLogs.push({ time: timestamp, type, message, severity: 'info' });
        showToast('📸 Screenshot Blocked', message, null, 'info');
        // Write to HR data (informational, no strike)
        appendViolation(sessionId, { time: timestamp, type, message, severity: 'info' });
        return;
    }

    // Capture webcam screenshot when candidate looks away
    let screenshot = null;
    if (type === 'gaze_away' || type === 'gaze_down') {
        screenshot = captureWebcamScreenshot();
    }

    // ── All other violations become strikes ───────────────────────────────────
    warnings++;
    const violation = { time: timestamp, type, message, severity, screenshot };
    violationLogs.push(violation);

    // ── Write violation to HR data ────────────────────────────────────────────
    appendViolation(sessionId, violation);
    // Update student record with latest violation count
    upsertStudent({
        sessionId,
        name: studentName,
        violations: violationLogs,
    });

    updateViolationGauge();

    const label = VIOLATION_LABELS[type] || type.toUpperCase();

    if (type === 'cell_phone') {
        // Immediate lockout for mobile phone detection
        showToast(`🚫 ${label}`, message, warnings, 'danger');
        setTimeout(() => {
            triggerLockout(message, type);
        }, 1800);
    } else {
        // Warning toast only, exam continues (no lockout block)
        showToast(`⚠️ ${label}`, message, warnings, 'warning');
    }
}

// ─── Violation Gauge UI ───────────────────────────────────────────────────────
function updateViolationGauge() {
    indicators.violationCount.textContent = `${warnings} / ${maxWarnings}`;
    const fillPercent = (warnings / maxWarnings) * 100;
    indicators.violationBar.style.width = `${fillPercent}%`;

    // Color gradient as warnings increase
    if (warnings >= maxWarnings - 1) {
        indicators.violationBar.style.background = 'linear-gradient(90deg, #ef4444, #dc2626)';
    } else if (warnings >= 1) {
        indicators.violationBar.style.background = 'linear-gradient(90deg, #f59e0b, #d97706)';
    }

    // Update strike dot circles
    for (let i = 1; i <= maxWarnings; i++) {
        const dot = document.getElementById(`strike-${i}`);
        if (!dot) continue;
        dot.className = 'strike-dot-item';
        if (i <= warnings) {
            dot.classList.add(`strike-active-${Math.min(i, 3)}`);
        }
    }
}

// ─── Fullscreen ───────────────────────────────────────────────────────────────
async function enterFullscreen() {
    const docEl = document.documentElement;
    try {
        if (docEl.requestFullscreen) await docEl.requestFullscreen();
        else if (docEl.webkitRequestFullscreen) await docEl.webkitRequestFullscreen();
        else if (docEl.msRequestFullscreen) await docEl.msRequestFullscreen();
        updateChecklistItem(checklist.fullscreen, 'success', 'Fullscreen mode locked');
        return true;
    } catch (err) {
        updateChecklistItem(checklist.fullscreen, 'failed', 'Fullscreen authorization failed');
        return false;
    }
}

// ─── Permission Check Flow ────────────────────────────────────────────────────
async function startVerificationCheck() {
    btns.requestPerms.disabled = true;

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

    updateChecklistItem(checklist.fullscreen, 'pending', 'Awaiting fullscreen activation...');
    const fullscreenAllowed = await enterFullscreen();
    if (!fullscreenAllowed) {
        btns.requestPerms.disabled = false;
        return;
    }

    enableStartIfReady();
}

// ─── Launch Exam ──────────────────────────────────────────────────────────────
async function launchExam() {
    // Refresh maxWarnings from HR portal settings
    maxWarnings = getMaxWarnings();

    // Check if this student's session is already blocked by HR
    if (isBlocked(sessionId)) {
        showHrBlockedScreen();
        return;
    }

    // Register student session in HR data
    upsertStudent({
        sessionId,
        name: studentName,
        email: studentEmail,
        domain: studentDomain,
        college: studentCollege,
        startTime: new Date().toISOString(),
        status: 'active',
        score: null,
        totalQuestions: activeQuestions.length,
        answered: 0,
        correct: 0,
        violations: [],
        endTime: null,
    });

    proctor.stopWebcamStream();

    views.setup.classList.remove('active');
    views.exam.classList.add('active');

    // Update exam header with student name
    const titleArea = document.querySelector('.exam-title-area h2');
    if (titleArea) titleArea.textContent = `Software Engineer Screening — ${studentName}`;

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
        handleProctorViolation('webcam_transfer', 'Failed to transfer webcam stream to exam container.', 'warning');
    });

    proctor.startEnvironmentMonitoring();
    timeLeft = activeQuestions.reduce((sum, q) => sum + (q.timeLimit || (q.type === 'text' ? 1500 : 300)), 0);
    startTimer();
    buildQuestionGrid();
    loadQuestion(0);

    // Apply screenshot CSS protection
    applyScreenshotProtection();

    // Poll for HR-initiated block every 5 seconds
    setInterval(() => {
        if (isBlocked(sessionId) && views.exam.classList.contains('active')) {
            proctor.stopAllStreams();
            clearInterval(timerInterval);
            showHrBlockedScreen();
        }
    }, 5000);
}

// ─── HR Manual Block Screen ───────────────────────────────────────────────────
function showHrBlockedScreen() {
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
    }
    Object.values(views).forEach(v => v && v.classList.remove('active'));

    // Customize blocked view for HR block
    const triggerLabel = document.getElementById('lockout-trigger-label');
    if (triggerLabel) triggerLabel.textContent = '🛑 Blocked by Administrator';

    const triggerMsg = document.getElementById('lockout-trigger-msg');
    if (triggerMsg) triggerMsg.textContent = 'You have been blocked from this exam by the HR administrator. Please contact your exam coordinator.';

    const sessionHashEl = document.getElementById('session-hash');
    if (sessionHashEl) sessionHashEl.textContent = sessionId;

    const blockViolationList = document.getElementById('block-violation-list');
    if (blockViolationList) {
        if (violationLogs.length > 0) {
            blockViolationList.innerHTML = violationLogs.map((log, idx) => `
                <li class="${idx === violationLogs.length - 1 ? 'final-strike' : ''}">
                    <span class="log-time">${log.time}</span>
                    <span class="log-type-badge">${VIOLATION_LABELS[log.type] || log.type.toUpperCase()}</span>
                    <span class="log-desc">${log.message}</span>
                </li>
            `).join('');
        } else {
            blockViolationList.innerHTML = '<li><span class="log-time">—</span> <span class="log-type-badge badge-critical">HR Block</span> Blocked by administrator before exam completion.</li>';
        }
    }

    views.blocked.classList.add('active');
}

/**
 * CSS-based screenshot deterrence — makes content unreadable in screenshots
 * via a print-specific style and user-select restrictions
 */
function applyScreenshotProtection() {
    // Disable text selection across exam content
    const examContent = document.querySelector('.exam-main-content');
    if (examContent) {
        examContent.style.userSelect = 'none';
        examContent.style.webkitUserSelect = 'none';
    }

    // Inject print-protection style (hides content in print/print-to-PDF)
    const printStyle = document.createElement('style');
    printStyle.id = 'print-protection';
    printStyle.textContent = `
        @media print {
            body * { visibility: hidden !important; }
            body::after {
                visibility: visible !important;
                content: '⚠️ THIS DOCUMENT IS PROTECTED. SCREENSHOT ATTEMPT RECORDED. SESSION ID: ' attr(data-session-id);
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                font-size: 24px;
                color: red;
                font-weight: bold;
                text-align: center;
            }
        }
    `;
    document.head.appendChild(printStyle);
}

// ─── Timer ────────────────────────────────────────────────────────────────────
function startTimer() {
    // Set initial text immediately
    const minutes = Math.floor(timeLeft / 60);
    const seconds = timeLeft % 60;
    indicators.timer.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    if (timeLeft < 300) {
        indicators.timer.style.color = '#ef4444';
    }

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

// ─── Question Navigation ──────────────────────────────────────────────────────
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
            if (answers[index] === optIdx) optBtn.classList.add('selected');

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
                // Update answered count in HR data
                const answeredCount = Object.keys(answers).length;
                upsertStudent({ sessionId, name: studentName, answered: answeredCount });
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

function updateQuestionStatus(index, status) {
    const gridItem = document.getElementById(`grid-q-${index}`);
    if (gridItem) {
        gridItem.className = `grid-item ${status}`;
        if (index === currentQuestionIndex) gridItem.classList.add('current');
    }
}

function handleNext() {
    if (currentQuestionIndex < activeQuestions.length - 1) loadQuestion(currentQuestionIndex + 1);
}
function handlePrev() {
    if (currentQuestionIndex > 0) loadQuestion(currentQuestionIndex - 1);
}
function handleSkip() {
    updateQuestionStatus(currentQuestionIndex, 'skipped');
    handleNext();
}

// ─── Score Calculation ────────────────────────────────────────────────────────
function calculateScore() {
    let correct = 0;
    let mcqTotal = 0;
    activeQuestions.forEach((q, idx) => {
        if (q.type === 'single') {
            mcqTotal++;
            if (answers[idx] === q.answer) correct++;
        }
    });
    const score = mcqTotal > 0 ? Math.round((correct / mcqTotal) * 100) : 0;
    return { score, correct, mcqTotal };
}

// ─── Finish Exam ──────────────────────────────────────────────────────────────
function finishExam() {
    proctor.stopAllStreams();
    clearInterval(timerInterval);

    if (document.fullscreenElement) {
        document.exitFullscreen().catch(err => console.log(err));
    }

    // Calculate score and save to HR data
    const { score, correct, mcqTotal } = calculateScore();
    const answeredCount = Object.keys(answers).length;

    updateStudentStatus(sessionId, 'completed', {
        score,
        correct,
        answered: answeredCount,
        totalQuestions: activeQuestions.length,
        endTime: new Date().toISOString(),
        violations: violationLogs,
    });

    views.exam.classList.remove('active');
    views.success.classList.add('active');

    // Populate success summary
    const summaryEl = document.getElementById('success-violation-count');
    if (summaryEl) summaryEl.textContent = warnings;
    const summaryList = document.getElementById('success-violation-summary');
    if (summaryList && violationLogs.length > 0) {
        summaryList.innerHTML = violationLogs.map(log =>
            `<li><span class="log-type">${VIOLATION_LABELS[log.type] || log.type}</span> — ${log.time}</li>`
        ).join('');
    }

    // Show score on success screen
    const scoreDisplay = document.getElementById('success-score-display');
    if (scoreDisplay) {
        scoreDisplay.textContent = `Your Score: ${score}% (${correct}/${mcqTotal} correct)`;
    }
}

// ─── Lockout Screen ───────────────────────────────────────────────────────────
function triggerLockout(reason, triggerType) {
    console.warn(`EXAM REVOKED: ${reason}`);

    proctor.stopAllStreams();
    clearInterval(timerInterval);

    try { media.setupWebcam.srcObject = null; } catch(_) {}
    try { media.examWebcam.srcObject = null; } catch(_) {}

    if (document.fullscreenElement) {
        document.exitFullscreen().catch(err => console.log(err));
    }

    // Mark student as blocked in HR data
    blockStudent(sessionId);
    updateStudentStatus(sessionId, 'blocked', {
        endTime: new Date().toISOString(),
        violations: violationLogs,
    });

    // Generate session ID display
    const sessionHashEl = document.getElementById('session-hash');
    if (sessionHashEl) {
        sessionHashEl.textContent = sessionId;
    }

    // Show why they were locked out — the trigger type gets a highlight
    const triggerLabel = document.getElementById('lockout-trigger-label');
    if (triggerLabel) {
        triggerLabel.textContent = VIOLATION_LABELS[triggerType] || 'Security Violation';
    }

    const triggerMsg = document.getElementById('lockout-trigger-msg');
    if (triggerMsg) {
        triggerMsg.textContent = reason;
    }

    // Build the full violation report
    const blockViolationList = document.getElementById('block-violation-list');
    if (blockViolationList) {
        blockViolationList.innerHTML = '';

        if (violationLogs.length === 0) {
            const item = document.createElement('li');
            item.innerHTML = `<span class="log-time">${new Date().toLocaleTimeString()}</span> <span class="log-type-badge">${VIOLATION_LABELS[triggerType] || 'VIOLATION'}</span> ${reason}`;
            blockViolationList.appendChild(item);
        } else {
            violationLogs.forEach((log, idx) => {
                const item = document.createElement('li');
                const isLast = idx === violationLogs.length - 1;
                item.className = isLast ? 'final-strike' : '';
                item.innerHTML = `
                    <span class="log-time">${log.time}</span>
                    <span class="log-type-badge ${log.type === triggerType && isLast ? 'badge-critical' : ''}">${VIOLATION_LABELS[log.type] || log.type.toUpperCase()}</span>
                    <span class="log-desc">${log.message}</span>
                `;
                blockViolationList.appendChild(item);
            });
        }
    }

    // Switch view
    Object.values(views).forEach(view => {
        if (view) view.classList.remove('active');
    });
    views.blocked.classList.add('active');
}

// ─── Event Bindings ───────────────────────────────────────────────────────────
btns.requestPerms.addEventListener('click', startVerificationCheck);
btns.startExam.addEventListener('click', launchExam);
btns.next.addEventListener('click', handleNext);
btns.prev.addEventListener('click', handlePrev);
btns.skip.addEventListener('click', handleSkip);
btns.submit.addEventListener('click', finishExam);

// ─── Real-Time Syncing ────────────────────────────────────────────────────────
window.addEventListener('storage', (e) => {
    if (e.key === 'proctor_exam_questions') {
        loadActiveQuestions();
        if (views.exam.classList.contains('active')) {
            buildQuestionGrid();
            if (currentQuestionIndex >= activeQuestions.length) {
                currentQuestionIndex = Math.max(0, activeQuestions.length - 1);
            }
            loadQuestion(currentQuestionIndex);
            showToast('📋 Questions Updated', 'The administrator has updated the exam questions.', null, 'info');
        }
    }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet/i
        .test(navigator.userAgent)
        || (navigator.maxTouchPoints > 1 && window.innerWidth < 1024)
        || window.innerWidth < 768;

    if (isMobile) {
        document.getElementById('mobile-block-overlay').classList.add('active');
        return;
    }

    loadActiveQuestions();

    // Fetch latest questions and blocklist from remote cloud database on startup
    fetch('https://kvdb.io/aifocused_proctor_db_x791a82/questions')
        .then(res => res.ok ? res.json() : null)
        .then(questions => {
            if (questions && Array.isArray(questions)) {
                localStorage.setItem('proctor_exam_questions', JSON.stringify(questions));
                loadActiveQuestions();
            }
        }).catch(err => console.log("Remote questions sync skipped, using local cache:", err));

    fetch('https://kvdb.io/aifocused_proctor_db_x791a82/blocked_ids')
        .then(res => res.ok ? res.json() : null)
        .then(blocked => {
            if (blocked && Array.isArray(blocked)) {
                localStorage.setItem('hr_blocked_ids', JSON.stringify(blocked));
            }
        }).catch(err => console.log("Remote blocklist sync skipped, using local cache:", err));

    // Set initial active view to registration
    Object.values(views).forEach(view => {
        if (view) view.classList.remove('active');
    });
    if (views.registration) {
        views.registration.classList.add('active');
    }

    // Google Form validation and submission
    const btnSubmitReg = document.getElementById('btn-submit-registration');
    const btnClearReg  = document.getElementById('btn-clear-registration');

    if (btnSubmitReg) {
        btnSubmitReg.addEventListener('click', () => {
            let isValid = true;

            const nameVal = document.getElementById('reg-name').value.trim();
            const emailVal = document.getElementById('reg-email').value.trim();
            const domainVal = document.getElementById('reg-domain').value.trim();
            const collegeVal = document.getElementById('reg-college').value.trim();

            // Name validate
            if (!nameVal) {
                document.getElementById('gcard-name').classList.add('error');
                document.getElementById('gerr-name').classList.add('visible');
                isValid = false;
            } else {
                document.getElementById('gcard-name').classList.remove('error');
                document.getElementById('gerr-name').classList.remove('visible');
            }

            // Email validate
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailVal || !emailRegex.test(emailVal)) {
                document.getElementById('gcard-email').classList.add('error');
                document.getElementById('gerr-email').classList.add('visible');
                isValid = false;
            } else {
                document.getElementById('gcard-email').classList.remove('error');
                document.getElementById('gerr-email').classList.remove('visible');
            }

            // Domain validate
            if (!domainVal) {
                document.getElementById('gcard-domain').classList.add('error');
                document.getElementById('gerr-domain').classList.add('visible');
                isValid = false;
            } else {
                document.getElementById('gcard-domain').classList.remove('error');
                document.getElementById('gerr-domain').classList.remove('visible');
            }

            // College validate
            if (!collegeVal) {
                document.getElementById('gcard-college').classList.add('error');
                document.getElementById('gerr-college').classList.add('visible');
                isValid = false;
            } else {
                document.getElementById('gcard-college').classList.remove('error');
                document.getElementById('gerr-college').classList.remove('visible');
            }

            if (isValid) {
                studentName = nameVal;
                studentEmail = emailVal;
                studentDomain = domainVal;
                studentCollege = collegeVal;

                // Move to permissions setup screen
                views.registration.classList.remove('active');
                views.registration.style.display = 'none';
                views.setup.classList.add('active');

                // Initialize tensorflow model download when entering setup screen
                updateChecklistItem(checklist.model, 'pending', 'Downloading TensorFlow model...');
                proctor.loadModel();
            }
        });
    }

    if (btnClearReg) {
        btnClearReg.addEventListener('click', () => {
            if (confirm('Are you sure you want to clear the form?')) {
                document.getElementById('reg-name').value = '';
                document.getElementById('reg-email').value = '';
                document.getElementById('reg-domain').value = '';
                document.getElementById('reg-college').value = '';
                document.querySelectorAll('.gform-card').forEach(c => c.classList.remove('error'));
                document.querySelectorAll('.gform-error-msg').forEach(m => m.classList.remove('visible'));
            }
        });
    }
});
