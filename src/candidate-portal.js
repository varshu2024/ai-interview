/**
 * Candidate Exam Report Portal
 * Fetches and displays a detailed summary of a candidate's session, proctoring log, and answers.
 */

import { getStudent, syncAllFromRemote, getQuestions, getMaxWarnings } from './hr-data.js';
import { questions as defaultQuestions } from './questions.js';

// ─── Authentication Lock ──────────────────────────────────────────────────────
if (sessionStorage.getItem('hr_portal_unlocked') !== 'true') {
    window.location.href = 'index.html';
}

const GAZE_TYPES = ['gaze_left', 'gaze_right', 'gaze_away', 'gaze_down'];
const VIOLATION_LABELS = {
    tab_switch: '📋 Tab Switched',
    window_blur: '🖥️ Window Unfocused',
    mouse_leave: '🖱️ Cursor Out of Page',
    fullscreen_exit: '🖥️ Fullscreen Exited',
    noise_detected: '🔊 Loud Vocal Noise',
    gaze_away: '👁️ Gaze Away (Left/Right)',
    gaze_down: '👁️ Looking Down Gaze',
    cell_phone: '📱 Mobile Phone Detected',
    copy_paste: '📋 Copy/Paste Attempt',
    devtools: '🛠️ DevTools Attempt',
    screenshot: '📸 Screenshot Blocked',
    keyboard_block: '⌨️ Keyboard Key Blocked',
    context_menu: '🖱️ Right-Click Attempted',
    screen_stopped: '🖥️ Screen Share Stopped',
    webcam_transfer: '📷 Webcam Disrupted',
    periodic_snapshot: '📷 Status Snapshot',
};

// ─── URL Query Parameter Parsing ──────────────────────────────────────────────
const urlParams = new URLSearchParams(window.location.search);
const sessionId = urlParams.get('id');

// ─── DOM Elements ─────────────────────────────────────────────────────────────
const elements = {
    loadingOverlay: document.getElementById('loading-overlay'),
    reportTitle: document.getElementById('candidate-report-title'),
    reportSub: document.getElementById('candidate-report-sub'),
    profileList: document.getElementById('profile-details-list'),
    proctorStats: document.getElementById('proctoring-stats-body'),
    timelineLog: document.getElementById('timeline-log-body'),
    responsesPanel: document.getElementById('responses-panel-body')
};

// ─── Helper: HTML Escape ──────────────────────────────────────────────────────
function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function statusBadgeHtml(status) {
    const map = {
        active:    { label: 'Active',    dot: true,  classVal: 'active' },
        completed: { label: 'Completed', dot: false, classVal: 'completed' },
        blocked:   { label: 'Blocked',   dot: false, classVal: 'blocked' },
        pending:   { label: 'Pending',   dot: false, classVal: 'pending' },
    };
    const info = map[status] || { label: status, dot: false, classVal: 'pending' };
    return `<span class="status-badge ${info.classVal}">${info.dot ? '<span class="status-dot"></span>' : ''}${info.label}</span>`;
}

// ─── Init Page ────────────────────────────────────────────────────────────────
async function init() {
    if (!sessionId) {
        showErrorPage('No Session ID provided in URL.');
        return;
    }

    try {
        // Sync fresh data from Firestore database on startup
        await syncAllFromRemote();
        renderReport();
    } catch (e) {
        console.error('Failed to sync candidate data:', e);
        // Load whatever exists in local storage fallback
        renderReport();
    } finally {
        if (elements.loadingOverlay) {
            elements.loadingOverlay.style.opacity = '0';
            setTimeout(() => {
                elements.loadingOverlay.style.display = 'none';
            }, 300);
        }
    }
}

function showErrorPage(message) {
    document.body.innerHTML = `
        <div style="max-width: 600px; margin: 5rem auto; padding: 2.5rem; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; text-align: center; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
            <div style="font-size: 3rem; margin-bottom: 1rem;">⚠️</div>
            <h2 style="font-weight: 700; color: #0f172a; margin-bottom: 0.5rem;">Report Load Error</h2>
            <p style="color: #64748b; font-size: 0.95rem; margin-bottom: 1.5rem;">${escHtml(message)}</p>
            <a href="index.html" style="display: inline-block; padding: 0.6rem 1.25rem; background: #2563eb; color: #ffffff; text-decoration: none; font-weight: 600; border-radius: 6px; font-size: 0.9rem;">Back to Dashboard</a>
        </div>
    `;
}

// ─── Render Report Data ───────────────────────────────────────────────────────
function renderReport() {
    const student = getStudent(sessionId);
    if (!student) {
        showErrorPage(`Candidate session '${sessionId}' was not found in the database records.`);
        return;
    }

    // Set page headers
    elements.reportTitle.textContent = `${escHtml(student.name || 'Candidate Report')}`;
    elements.reportSub.textContent = `Detailed session review & response log for ID: ${sessionId}`;

    renderProfile(student);
    renderProctoringStats(student);
    renderTimelineLog(student);
    renderExamResponses(student);
}

// 1. Render Candidate Profile Details
function renderProfile(student) {
    const maxScore = student.score !== null ? student.score : 0;
    const scoreColor = maxScore >= 70 ? '#10b981' : maxScore >= 40 ? '#f59e0b' : '#ef4444';

    elements.profileList.innerHTML = `
        <div class="stats-circle-container">
            <div class="stats-radial" style="--score-color: ${scoreColor}; --score-percent: ${maxScore}%">
                <div class="stats-radial-text">
                    <div class="stats-radial-value">${student.score !== null ? student.score + '%' : '—'}</div>
                    <div class="stats-radial-label">Score</div>
                </div>
            </div>
        </div>

        <div class="profile-info-item">
            <span class="profile-info-label">Full Name</span>
            <span class="profile-info-value" style="font-weight: 700;">${escHtml(student.name || 'Unknown')}</span>
        </div>
        <div class="profile-info-item">
            <span class="profile-info-label">Session ID</span>
            <span class="profile-info-value" style="font-family: monospace; font-size: 0.8rem; color: #2563eb;">${student.sessionId}</span>
        </div>
        <div class="profile-info-item">
            <span class="profile-info-label">Email Address</span>
            <span class="profile-info-value">${escHtml(student.email || '—')}</span>
        </div>
        <div class="profile-info-item">
            <span class="profile-info-label">Phone Number</span>
            <span class="profile-info-value">${escHtml(student.phone || '—')}</span>
        </div>
        <div class="profile-info-item">
            <span class="profile-info-label">College / Organization</span>
            <span class="profile-info-value">🏫 ${escHtml(student.location || '—')}</span>
        </div>
        <div class="profile-info-item">
            <span class="profile-info-label">Registered Date</span>
            <span class="profile-info-value">📅 ${escHtml(student.date || '—')}</span>
        </div>
        <div class="profile-info-item">
            <span class="profile-info-label">Status</span>
            <span class="profile-info-value" style="margin-top: 2px;">${statusBadgeHtml(student.status)}</span>
        </div>
        <div class="profile-info-item">
            <span class="profile-info-label">Exam Timings</span>
            <span class="profile-info-value" style="font-size: 0.8rem; line-height: 1.4; color: #475569;">
                🕐 Started: <strong>${student.startTime ? new Date(student.startTime).toLocaleString() : '—'}</strong><br>
                🏁 Ended: <strong>${student.endTime ? new Date(student.endTime).toLocaleString() : 'In Progress'}</strong>
            </span>
        </div>
    `;
}

// 2. Render Proctoring Security Stats
function renderProctoringStats(student) {
    const violations = student.violations || [];
    const strikeViolations = violations.filter(v => !['screenshot', 'keyboard_block', 'context_menu', 'periodic_snapshot'].includes(v.type));
    const gazeCount = violations.filter(v => GAZE_TYPES.includes(v.type)).length;
    const phoneCount = violations.filter(v => v.type === 'cell_phone').length;
    const maxWarn = getMaxWarnings();

    elements.proctorStats.innerHTML = `
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem;">
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 0.75rem; text-align: center;">
                <div style="font-size: 1.25rem; font-weight: 700; color: ${strikeViolations.length >= maxWarn ? '#dc2626' : strikeViolations.length > 0 ? '#d97706' : '#1e293b'};">${strikeViolations.length} / ${maxWarn}</div>
                <div style="font-size: 0.65rem; font-weight: 600; color: #64748b; text-transform: uppercase; margin-top: 0.2rem;">Total Strikes</div>
            </div>
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 0.75rem; text-align: center;">
                <div style="font-size: 1.25rem; font-weight: 700; color: ${gazeCount > 0 ? '#d97706' : '#1e293b'}">${gazeCount}</div>
                <div style="font-size: 0.65rem; font-weight: 600; color: #64748b; text-transform: uppercase; margin-top: 0.2rem;">Gaze Away Flags</div>
            </div>
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 0.75rem; text-align: center; margin-top: 0.4rem; grid-column: span 2;">
                <div style="font-size: 1.25rem; font-weight: 700; color: ${phoneCount > 0 ? '#dc2626' : '#1e293b'}">${phoneCount}</div>
                <div style="font-size: 0.65rem; font-weight: 600; color: #64748b; text-transform: uppercase; margin-top: 0.2rem;">Mobile Phone Detections</div>
            </div>
        </div>
        <div style="margin-top: 1rem; font-size: 0.76rem; color: #64748b; line-height: 1.45;">
            🔒 Lockouts only trigger immediately upon Mobile Phone detection. All other proctoring warnings increment the strike meter up to ${maxWarn}.
        </div>
    `;
}

// 3. Render Timeline Events and Violation Screenshots
function renderTimelineLog(student) {
    const violations = student.violations || [];
    if (violations.length === 0) {
        elements.timelineLog.innerHTML = `
            <div style="text-align: center; padding: 2rem 1rem; color: #64748b;">
                <div style="font-size: 2rem; margin-bottom: 0.5rem;">✅</div>
                <div style="font-weight: 600; font-size: 0.85rem;">No security issues flagged</div>
                <p style="font-size: 0.76rem; margin: 0.25rem 0 0 0;">Candidate followed security rules perfectly.</p>
            </div>
        `;
        return;
    }

    // Timeline list (without direct embedded screenshots to prevent vertical clutter)
    const logsHtml = violations.map(v => {
        const isCritical = v.type === 'cell_phone' || v.severity === 'critical';
        const isWarning = !isCritical && v.type !== 'periodic_snapshot' && v.type !== 'screenshot';
        
        let typeClass = 'timeline-item';
        let badgeStyle = 'background: #cbd5e1; color: #334155;';
        
        if (isCritical) {
            typeClass = 'timeline-item critical';
            badgeStyle = 'background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca;';
        } else if (isWarning) {
            typeClass = 'timeline-item warning';
            badgeStyle = 'background: #fef3c7; color: #b45309; border: 1px solid #fde68a;';
        }

        return `
            <li class="${typeClass}">
                <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.25rem;">
                    <span class="timeline-time">${v.time || '—'}</span>
                    <span class="timeline-type" style="${badgeStyle}">${VIOLATION_LABELS[v.type] || v.type}</span>
                </div>
                <div class="timeline-message">${escHtml(v.message || '')}</div>
            </li>
        `;
    }).join('');

    // Screenshot gallery (at the bottom)
    const screenshots = violations.filter(v => v.screenshot && v.screenshot.trim().length > 0);
    const screenshotGalleryHtml = screenshots.length > 0 ? `
        <div style="margin-top: 2rem; border-top: 1px solid #e2e8f0; padding-top: 1.5rem;">
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;">
                <span style="font-size: 1.1rem;">📸</span>
                <span style="font-size: 0.9rem; font-weight: 700; color: #0f172a;">Captured Security Screenshots &amp; Photos</span>
                <span style="font-size: 0.72rem; font-weight: 600; color: #2563eb; background: #eff6ff; border: 1px solid #bfdbfe; padding: 0.15rem 0.5rem; border-radius: 20px; margin-left: 0.25rem;">
                    ${screenshots.length} photo${screenshots.length !== 1 ? 's' : ''}
                </span>
            </div>
            <div style="
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
                gap: 1rem;
            ">
                ${screenshots.map((v, idx) => `
                    <div style="
                        border: 1px solid #e2e8f0;
                        border-radius: 10px;
                        overflow: hidden;
                        background: #f8fafc;
                        box-shadow: 0 2px 8px rgba(0,0,0,0.04);
                        transition: transform 0.15s ease, box-shadow 0.15s ease;
                    " onmouseenter="this.style.transform='scale(1.02)';this.style.boxShadow='0 6px 20px rgba(0,0,0,0.1)'"
                       onmouseleave="this.style.transform='scale(1)';this.style.boxShadow='0 2px 8px rgba(0,0,0,0.04)'">
                        <a href="${v.screenshot}" target="_blank" rel="noopener noreferrer">
                            <img
                                src="${v.screenshot}"
                                alt="Screenshot ${idx + 1}: ${VIOLATION_LABELS[v.type] || v.type}"
                                style="width: 100%; height: 160px; object-fit: cover; display: block; border-bottom: 1px solid #e2e8f0;"
                                loading="lazy"
                            />
                        </a>
                        <div style="padding: 0.5rem 0.75rem;">
                            <div style="
                                font-size: 0.7rem;
                                font-weight: 700;
                                color: ${v.type === 'cell_phone' ? '#dc2626' : '#b45309'};
                                text-transform: uppercase;
                                letter-spacing: 0.03em;
                            ">${VIOLATION_LABELS[v.type] || v.type}</div>
                            <div style="font-size: 0.68rem; font-family: monospace; color: #64748b; margin-top: 0.1rem;">
                                🕐 ${v.time || '—'}
                            </div>
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    ` : `
        <div style="margin-top: 1.5rem; border-top: 1px solid #e2e8f0; padding-top: 1.25rem; text-align: center; color: #94a3b8; font-size: 0.8rem;">
            📸 No screenshots were captured during this session.
        </div>
    `;

    elements.timelineLog.innerHTML = `
        <ul class="timeline-list">${logsHtml}</ul>
        ${screenshotGalleryHtml}
    `;
}

// 4. Render Attempted Exam Answers and Responses
function renderExamResponses(student) {
    const storedQ = getQuestions();
    const questions = (storedQ && storedQ.length > 0) ? storedQ : defaultQuestions;
    // Firestore stores keys as strings ("0","1"...) — normalize to string keys
    const rawAnswers = student.answers || {};
    const answers = {};
    for (const k of Object.keys(rawAnswers)) {
        answers[String(k)] = rawAnswers[k];
    }

    elements.responsesPanel.innerHTML = '';

    if (questions.length === 0) {
        elements.responsesPanel.innerHTML = '<div style="text-align: center; padding: 2rem; color: #64748b;">No exam questions loaded.</div>';
        return;
    }

    const answeredCount = Object.keys(answers).filter(k => answers[k] !== null && answers[k] !== undefined).length;
    document.getElementById('answers-panel-title').innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; width: 100%;">
            <span>📝 Exam Answers &amp; Code Submissions</span>
            <span style="font-size: 0.78rem; font-weight: 600; color: #2563eb; background: #eff6ff; padding: 0.25rem 0.6rem; border-radius: 20px; border: 1px solid #bfdbfe;">
                ${answeredCount} / ${questions.length} Attempted
            </span>
        </div>
    `;

    // Map all questions and render them with candidate's answers
    // Use string keys to match Firestore-stored answer map
    const answersHtml = questions.map((q, idx) => {
        const key = String(idx);
        const attempted = answers.hasOwnProperty(key) && answers[key] !== null && answers[key] !== undefined;
        const candidateAns = attempted ? answers[key] : null;

        let responseHtml = '';
        let statusBadge = '';

        if (!attempted) {
            statusBadge = `<span style="font-size: 0.7rem; font-weight: 600; color: #64748b; background: #f1f5f9; padding: 0.2rem 0.5rem; border-radius: 4px; border: 1px solid #cbd5e1;">⚠️ Not Attempted</span>`;
            responseHtml = `
                <div style="font-size: 0.8rem; margin-top: 0.5rem; color: #94a3b8; font-style: italic;">
                    No answer was recorded for this question.
                </div>
            `;
        } else {
            if (q.type === 'single') {
                // MCQ Single choice
                const optLetter = String.fromCharCode(65 + candidateAns);
                const isCorrect = candidateAns === q.answer;
                const correctOptLetter = String.fromCharCode(65 + q.answer);

                statusBadge = isCorrect
                    ? `<span style="font-size: 0.7rem; font-weight: 700; color: #15803d; background: #dcfce7; padding: 0.2rem 0.5rem; border-radius: 4px; border: 1px solid #bbf7d0;">✓ Correct</span>`
                    : `<span style="font-size: 0.7rem; font-weight: 700; color: #b91c1c; background: #fee2e2; padding: 0.2rem 0.5rem; border-radius: 4px; border: 1px solid #fecaca;">✗ Incorrect</span>`;

                responseHtml = `
                    <div style="font-size: 0.82rem; margin-top: 0.6rem; color: #334155;">
                        <div style="margin-bottom: 0.25rem;">Candidate Answer: <strong style="color: ${isCorrect ? '#16a34a' : '#dc2626'}">${optLetter}. ${escHtml(q.options[candidateAns] || '')}</strong></div>
                        ${!isCorrect ? `<div style="color: #15803d; font-weight: 500;">Correct Answer: <strong>${correctOptLetter}. ${escHtml(q.options[q.answer] || '')}</strong></div>` : ''}
                    </div>
                    <div style="margin-top: 0.75rem; border-top: 1px dashed #e2e8f0; padding-top: 0.5rem; display: flex; flex-direction: column; gap: 0.3rem;">
                        ${q.options.map((opt, oIdx) => {
                            const isChosen = oIdx === candidateAns;
                            const isCorrectAns = oIdx === q.answer;
                            let style = 'color: #475569;';
                            let icon = '⚪';
                            if (isChosen) {
                                style = isCorrect ? 'color: #16a34a; font-weight: 600;' : 'color: #dc2626; font-weight: 600;';
                                icon = isCorrect ? '🟢' : '🔴';
                            } else if (isCorrectAns) {
                                style = 'color: #16a34a; font-weight: 600;';
                                icon = '🟢';
                            }
                            return `<div style="font-size: 0.78rem; display: flex; gap: 0.4rem; ${style}"><span>${icon}</span><span>${String.fromCharCode(65 + oIdx)}. ${escHtml(opt)}</span></div>`;
                        }).join('')}
                    </div>
                `;
            } else if (q.type === 'text') {
                // Descriptive text
                const textVal = String(candidateAns || '');
                const wordCount = textVal.trim().split(/\s+/).filter(w => w.length > 0).length;

                statusBadge = `<span style="font-size: 0.7rem; font-weight: 600; color: #2563eb; background: #eff6ff; padding: 0.2rem 0.5rem; border-radius: 4px; border: 1px solid #bfdbfe;">✍️ Written Response (${wordCount} words)</span>`;
                responseHtml = `
                    <div style="
                        margin-top: 0.75rem;
                        padding: 1rem 1.25rem;
                        background: #f8fafc;
                        border: 1px solid #e2e8f0;
                        border-radius: 8px;
                        font-size: 0.85rem;
                        color: #1e293b;
                        white-space: pre-wrap;
                        line-height: 1.6;
                        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        box-shadow: inset 0 1px 2px rgba(0,0,0,0.02);
                    ">${escHtml(textVal)}</div>
                `;
            }
        }

        return `
            <div class="answer-box">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 1.5rem; flex-wrap: wrap;">
                    <div style="font-size: 0.875rem; font-weight: 700; color: #1e293b; flex: 1;">
                        <span style="color: #64748b; margin-right: 0.2rem;">Q${idx + 1}.</span> ${escHtml(q.text)}
                    </div>
                    <div>${statusBadge}</div>
                </div>
                ${responseHtml}
            </div>
        `;
    }).join('');

    elements.responsesPanel.innerHTML = answersHtml;
}

// Run init
window.addEventListener('DOMContentLoaded', init);
