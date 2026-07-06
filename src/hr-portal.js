/**
 * HR Admin Portal — Main Controller
 * Manages live student dashboard, cheating details, question CRUD, and block controls.
 */

import {
    getAllStudents, blockStudent, unblockStudent, getBlockedIds,
    getQuestions, saveQuestions, getMaxWarnings, saveMaxWarnings,
    clearAllStudents, upsertStudent, syncAllFromRemote
} from './hr-data.js';
import { questions as defaultQuestions } from './questions.js';

// ─── State ────────────────────────────────────────────────────────────────────
let currentPanel = 'dashboard';
let currentEditIndex = null;   // for question editing
let expandedStudentId = null;  // for violation drawer
let filterStatus = 'all';
let searchQuery = '';
let refreshTimer = null;

// ─── Violation Labels ─────────────────────────────────────────────────────────
const VIOLATION_LABELS = {
    tab_switch:     '🔁 Tab Switch',
    window_blur:    '🖱️ Window Blur',
    mouse_leave:    '↗️ Mouse Left',
    fullscreen_exit:'⛶ Fullscreen Exit',
    noise:          '🔊 Audio Noise',
    no_person:      '👤 No Face',
    multiple_people:'👥 Multiple People',
    cell_phone:     '📱 Phone Detected',
    gaze_away:      '👁️ Eyes Off Screen',
    gaze_down:      '👁️ Looking Down',
    copy_paste:     '📋 Copy/Paste',
    devtools:       '🛠️ DevTools',
    screenshot:     '📸 Screenshot',
    keyboard_block: '⌨️ Key Blocked',
    context_menu:   '🖱️ Right-Click',
    screen_stopped: '🖥️ Screen Stopped',
    webcam_transfer:'📷 Webcam Error',
};

const GAZE_TYPES = ['gaze_away', 'gaze_down', 'no_person'];

// ─── Entry Point ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    setupNavigation();
    setupModals();
    setupFilters();
    setupSettings();
    setupClearData();

    // Initial sync and render
    syncAllFromRemote().then(() => {
        renderDashboard();
        renderStudentsTable();
        renderQuestionsPanel();
    });

    // Auto-refresh every 3 seconds
    refreshTimer = setInterval(() => {
        syncAllFromRemote().then(() => {
            renderDashboard();
            renderStudentsTable();
        });
    }, 3000);
});

// ─── Navigation ───────────────────────────────────────────────────────────────
function setupNavigation() {
    document.querySelectorAll('.hr-nav-item[data-panel]').forEach(item => {
        item.addEventListener('click', () => {
            const panel = item.dataset.panel;
            switchPanel(panel);
        });
    });
}

function switchPanel(panelId) {
    currentPanel = panelId;

    document.querySelectorAll('.hr-nav-item').forEach(i => i.classList.remove('active'));
    const navItem = document.querySelector(`.hr-nav-item[data-panel="${panelId}"]`);
    if (navItem) navItem.classList.add('active');

    document.querySelectorAll('.hr-panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById(`panel-${panelId}`);
    if (panel) panel.classList.add('active');

    if (panelId === 'dashboard') renderDashboard();
    if (panelId === 'students')  renderStudentsTable();
    if (panelId === 'questions') renderQuestionsPanel();
    if (panelId === 'settings')  renderSettings();
}

// ─── Dashboard Panel ──────────────────────────────────────────────────────────
function renderDashboard() {
    const students = getAllStudents();
    const total     = students.length;
    const active    = students.filter(s => s.status === 'active').length;
    const completed = students.filter(s => s.status === 'completed').length;
    const blocked   = students.filter(s => s.status === 'blocked').length;

    setMetric('metric-total',     total);
    setMetric('metric-active',    active);
    setMetric('metric-completed', completed);
    setMetric('metric-blocked',   blocked);

    // Average score of completed
    const completedStudents = students.filter(s => s.status === 'completed' && s.score !== null);
    const avgScore = completedStudents.length > 0
        ? Math.round(completedStudents.reduce((sum, s) => sum + s.score, 0) / completedStudents.length)
        : 0;
    setMetric('metric-avg-score', `${avgScore}%`);

    // Total violations
    const totalViolations = students.reduce((sum, s) => sum + (s.violations ? s.violations.length : 0), 0);
    setMetric('metric-violations', totalViolations);

    // Recent activity list
    renderRecentActivity(students);
}

function setMetric(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function renderRecentActivity(students) {
    const container = document.getElementById('recent-activity-list');
    if (!container) return;

    // Collect all violations across all students, sorted by time
    const events = [];
    students.forEach(s => {
        (s.violations || []).forEach(v => {
            events.push({ student: s.name, ...v, sessionId: s.sessionId });
        });
        if (s.status === 'blocked') {
            events.push({ student: s.name, type: 'blocked', message: 'Student blocked from exam', time: s.endTime || '--', sessionId: s.sessionId });
        }
    });

    // Show last 8
    const recent = events.slice(-8).reverse();

    if (recent.length === 0) {
        container.innerHTML = `<div class="hr-empty-state"><div class="hr-empty-icon">📋</div><h4>No activity yet</h4><p>Student exam events will appear here once sessions begin.</p></div>`;
        return;
    }

    container.innerHTML = recent.map(ev => `
        <div class="activity-row">
            <div class="activity-icon">${getViolationEmoji(ev.type)}</div>
            <div class="activity-body">
                <div class="activity-title"><strong>${escHtml(ev.student)}</strong> — ${VIOLATION_LABELS[ev.type] || ev.type}</div>
                <div class="activity-msg">${escHtml(ev.message || '')}</div>
            </div>
            <div class="activity-time">${ev.time || '--'}</div>
        </div>
    `).join('');
}

// ─── Students Table Panel ─────────────────────────────────────────────────────
function renderStudentsTable() {
    let students = getAllStudents();

    // Apply filter
    if (filterStatus !== 'all') {
        students = students.filter(s => s.status === filterStatus);
    }

    // Apply search
    if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        students = students.filter(s =>
            (s.name || '').toLowerCase().includes(q) ||
            (s.sessionId || '').toLowerCase().includes(q)
        );
    }

    const tbody = document.getElementById('students-tbody');
    if (!tbody) return;

    if (students.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8"><div class="hr-empty-state"><div class="hr-empty-icon">👤</div><h4>No students found</h4><p>Waiting for exam sessions to begin.</p></div></td></tr>`;
        return;
    }

    tbody.innerHTML = students.map(s => {
        const violCount   = (s.violations || []).length;
        const strikeCount = (s.violations || []).filter(v => !['screenshot', 'keyboard_block', 'context_menu'].includes(v.type)).length;
        const gazeCount   = (s.violations || []).filter(v => GAZE_TYPES.includes(v.type)).length;
        const maxWarn     = getMaxWarnings();
        const scoreClass  = (s.score || 0) >= 70 ? 'high' : (s.score || 0) >= 40 ? 'mid' : 'low';
        const scoreDisplay = s.score !== null ? `${s.score}%` : '—';
        const scoreBar     = s.score !== null
            ? `<div class="score-bar-wrap">
                <div class="score-bar-track"><div class="score-bar-fill ${scoreClass}" style="width:${s.score}%"></div></div>
                <span class="score-label">${s.score}%</span>
               </div>`
            : '<span style="color:var(--hr-text-muted)">—</span>';

        const isBlocked = s.status === 'blocked';
        const statusBadge = statusBadgeHtml(s.status);

        return `
            <tr data-session="${s.sessionId}" onclick="toggleViolationDrawer('${s.sessionId}')">
                <td>
                    <div style="font-weight:600;color:var(--hr-text)">${escHtml(s.name || 'Unknown')}</div>
                    <div style="font-size:0.72rem;color:var(--hr-text-muted);font-family:monospace">${s.sessionId}</div>
                </td>
                <td style="font-size:0.82rem;color:var(--hr-text-secondary)">${escHtml(s.email || '—')}</td>
                <td>
                    <div style="font-weight:500;color:var(--hr-text)">${escHtml(s.domain || '—')}</div>
                    <div style="font-size:0.72rem;color:var(--hr-text-muted)">${escHtml(s.college || '—')}</div>
                </td>
                <td>${statusBadge}</td>
                <td>${scoreBar}</td>
                <td>
                    <span style="font-weight:700;color:${strikeCount >= maxWarn ? 'var(--hr-danger)' : strikeCount > 0 ? 'var(--hr-warning)' : 'var(--hr-text-muted)'}">${strikeCount}</span>
                    <span style="color:var(--hr-text-muted);font-size:0.78rem"> / ${maxWarn}</span>
                </td>
                <td><span style="color:${gazeCount > 0 ? 'var(--hr-warning)' : 'var(--hr-text-muted)'}">${gazeCount > 0 ? `👁️ ${gazeCount}` : '—'}</span></td>
                <td onclick="event.stopPropagation()">
                    ${isBlocked
                        ? `<button class="hr-btn hr-btn-success hr-btn-sm" onclick="hrUnblockStudent('${s.sessionId}')">✓ Unblock</button>`
                        : `<button class="hr-btn hr-btn-danger hr-btn-sm" onclick="hrBlockStudent('${s.sessionId}')">🚫 Block</button>`
                    }
                </td>
            </tr>
            <tr id="drawer-${s.sessionId}" class="violation-drawer-row">
                <td colspan="8" style="padding:0">
                    <div id="drawer-content-${s.sessionId}" class="violation-drawer ${expandedStudentId === s.sessionId ? 'open' : ''}">
                        ${buildViolationDrawer(s)}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function buildViolationDrawer(student) {
    const violations = student.violations || [];
    const strikeViolations = violations.filter(v => !['screenshot', 'keyboard_block', 'context_menu'].includes(v.type));
    const gazeCount = violations.filter(v => GAZE_TYPES.includes(v.type)).length;
    const phoneCount = violations.filter(v => v.type === 'cell_phone').length;

    const gazeStatsHtml = `
        <div class="gaze-stats-row">
            <span class="gaze-stat-chip eye">👁️ Gaze violations: ${gazeCount}</span>
            <span class="gaze-stat-chip warn">📱 Phone detections: ${phoneCount}</span>
            <span class="gaze-stat-chip warn">⚠️ Total strikes: ${strikeViolations.length}</span>
        </div>
    `;

    if (violations.length === 0) {
        return `
            <h4>📋 Cheating / Violation Details</h4>
            ${gazeStatsHtml}
            <div class="no-violations">✅ No violations recorded for this session.</div>
        `;
    }

    const violationListHtml = violations.map(v => {
        const chipClass = GAZE_TYPES.includes(v.type) ? 'gaze' : v.type === 'cell_phone' ? 'phone' : v.type === 'screenshot' ? 'screenshot' : '';
        const screenshotHtml = v.screenshot
            ? `<div class="v-screenshot-wrap" style="margin-top: 0.5rem; max-width: 240px; border-radius: 8px; overflow: hidden; border: 1.5px solid rgba(255,255,255,0.08); box-shadow: 0 4px 12px rgba(0,0,0,0.3);">
                <img src="${v.screenshot}" alt="Violation Capture" style="width: 100%; display: block; filter: contrast(1.05);" />
               </div>`
            : '';
        return `
            <li style="margin-bottom: 1.25rem; list-style: none;">
                <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
                    <span class="v-time">${v.time || '--'}</span>
                    <span class="v-type-chip ${chipClass}">${VIOLATION_LABELS[v.type] || v.type}</span>
                    <span class="v-msg" style="color: var(--hr-text-secondary);">${escHtml(v.message || '')}</span>
                </div>
                ${screenshotHtml}
            </li>
        `;
    }).join('');

    return `
        <h4>📋 Cheating / Violation Details — ${escHtml(student.name || 'Unknown')}</h4>
        ${gazeStatsHtml}
        <ul class="violation-list-hr" style="margin-top:0.75rem; padding-left: 0;">${violationListHtml}</ul>
    `;
}

function statusBadgeHtml(status) {
    const map = {
        active:    { label: 'Active',    dot: true },
        completed: { label: 'Completed', dot: false },
        blocked:   { label: 'Blocked',   dot: false },
    };
    const info = map[status] || { label: status, dot: false };
    return `<span class="status-badge ${status}">${info.dot ? '<span class="status-dot"></span>' : ''}${info.label}</span>`;
}

// Global function for row click
window.toggleViolationDrawer = function(sessionId) {
    if (expandedStudentId === sessionId) {
        expandedStudentId = null;
    } else {
        expandedStudentId = sessionId;
    }

    // Close all drawers
    document.querySelectorAll('.violation-drawer').forEach(d => d.classList.remove('open'));

    if (expandedStudentId) {
        const drawer = document.getElementById(`drawer-content-${expandedStudentId}`);
        if (drawer) drawer.classList.add('open');
    }

    // Mark selected row
    document.querySelectorAll('#students-tbody tr[data-session]').forEach(row => {
        row.classList.toggle('selected', row.dataset.session === expandedStudentId);
    });
};

window.hrBlockStudent = function(sessionId) {
    blockStudent(sessionId);
    renderStudentsTable();
    renderDashboard();
    showHrToast('Student blocked from exam.', 'error');
};

window.hrUnblockStudent = function(sessionId) {
    unblockStudent(sessionId);
    renderStudentsTable();
    renderDashboard();
    showHrToast('Student unblocked successfully.', 'success');
};

// ─── Filters ──────────────────────────────────────────────────────────────────
function setupFilters() {
    const searchInput  = document.getElementById('student-search');
    const statusSelect = document.getElementById('student-filter-status');

    if (searchInput) {
        searchInput.addEventListener('input', e => {
            searchQuery = e.target.value;
            renderStudentsTable();
        });
    }

    if (statusSelect) {
        statusSelect.addEventListener('change', e => {
            filterStatus = e.target.value;
            renderStudentsTable();
        });
    }
}

// ─── Question Manager Panel ───────────────────────────────────────────────────
function renderQuestionsPanel() {
    const storedQ = getQuestions();
    const questions = (storedQ && storedQ.length > 0) ? storedQ : JSON.parse(JSON.stringify(defaultQuestions));

    const list = document.getElementById('qm-list');
    if (!list) return;

    if (questions.length === 0) {
        list.innerHTML = `<div class="hr-empty-state"><div class="hr-empty-icon">❓</div><h4>No questions</h4><p>Add questions using the button above.</p></div>`;
        return;
    }

    list.innerHTML = questions.map((q, idx) => {
        const optsSummary = q.options && q.options.length > 0
            ? `${q.options.length} options`
            : 'Open-ended';

        return `
            <li class="qm-item">
                <div class="qm-number">${idx + 1}</div>
                <div class="qm-content">
                    <div class="qm-text">${escHtml(q.text)}</div>
                    <div class="qm-meta">
                        <span class="qm-type-badge">${q.type === 'single' ? '⊙ Multiple Choice' : '✏️ Text'}</span>
                        <span class="qm-opts-count">${optsSummary}</span>
                        <span class="qm-time-badge" style="font-size:0.72rem;background:rgba(255,255,255,0.06);padding:0.1rem 0.4rem;border-radius:4px;color:var(--hr-text-secondary)">⏱️ ${q.timeLimit || (q.type === 'text' ? 1500 : 300)}s</span>
                        ${q.answer !== null && q.answer !== undefined ? `<span style="font-size:0.72rem;color:var(--hr-success)">✓ Answer: ${String.fromCharCode(65 + q.answer)}</span>` : ''}
                    </div>
                </div>
                <div class="qm-actions">
                    <button class="hr-btn hr-btn-ghost hr-btn-sm" onclick="openEditQuestion(${idx})">✏️ Edit</button>
                    <button class="hr-btn hr-btn-danger hr-btn-sm" onclick="deleteQuestion(${idx})">🗑️</button>
                </div>
            </li>
        `;
    }).join('');

    // Update question count badge
    const badge = document.getElementById('qm-count-badge');
    if (badge) badge.textContent = `${questions.length} questions`;
}

window.openEditQuestion = function(idx) {
    currentEditIndex = idx;
    const stored = getQuestions();
    const questions = (stored && stored.length > 0) ? stored : JSON.parse(JSON.stringify(defaultQuestions));
    const q = questions[idx];
    openQuestionModal(q, idx);
};

window.deleteQuestion = function(idx) {
    if (!confirm('Delete this question? This cannot be undone.')) return;
    const stored = getQuestions();
    const questions = (stored && stored.length > 0) ? stored : JSON.parse(JSON.stringify(defaultQuestions));
    questions.splice(idx, 1);
    saveQuestions(questions);
    renderQuestionsPanel();
    showHrToast('Question deleted.', 'info');
};

function openQuestionModal(q = null, editIdx = null) {
    currentEditIndex = editIdx;
    const modal = document.getElementById('question-modal');
    if (!modal) return;

    const title = document.getElementById('qm-modal-title');
    if (title) title.textContent = editIdx !== null ? 'Edit Question' : 'Add New Question';

    const typeSelect = document.getElementById('qm-type');
    const textInput  = document.getElementById('qm-text');
    const timeLimitInput = document.getElementById('qm-time-limit');

    if (q) {
        typeSelect.value = q.type || 'single';
        textInput.value  = q.text || '';
        if (timeLimitInput) timeLimitInput.value = q.timeLimit || (q.type === 'text' ? 1500 : 300);
    } else {
        typeSelect.value = 'single';
        textInput.value  = '';
        if (timeLimitInput) timeLimitInput.value = 300;
    }

    updateModalOptions(q);
    typeSelect.onchange = () => updateModalOptions(null);
    modal.classList.add('open');
}

function updateModalOptions(q) {
    const typeSelect = document.getElementById('qm-type');
    const optionsSection = document.getElementById('qm-options-section');
    if (!optionsSection) return;

    if (typeSelect.value === 'text') {
        optionsSection.style.display = 'none';
        return;
    }

    optionsSection.style.display = '';
    const optContainers = document.querySelectorAll('.hr-option-row input[type="text"]');
    const radios = document.querySelectorAll('.hr-option-row input[type="radio"]');

    if (q && q.options && q.options.length > 0) {
        optContainers.forEach((inp, i) => {
            inp.value = q.options[i] || '';
        });
        radios.forEach((r, i) => {
            r.checked = (q.answer === i);
        });
    } else {
        optContainers.forEach(inp => { inp.value = ''; });
        radios.forEach((r, i) => { r.checked = (i === 0); });
    }
}

function setupModals() {
    // Add Question button
    const addBtn = document.getElementById('btn-add-question');
    if (addBtn) addBtn.addEventListener('click', () => openQuestionModal(null, null));

    // Save question
    const saveBtn = document.getElementById('btn-save-question');
    if (saveBtn) saveBtn.addEventListener('click', saveQuestionFromModal);

    // Close modal
    document.querySelectorAll('.hr-modal-close, .btn-modal-cancel').forEach(btn => {
        btn.addEventListener('click', closeAllModals);
    });

    // Close on overlay click
    document.querySelectorAll('.hr-modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', e => {
            if (e.target === overlay) closeAllModals();
        });
    });
}

function closeAllModals() {
    document.querySelectorAll('.hr-modal-overlay').forEach(m => m.classList.remove('open'));
    currentEditIndex = null;
}

function saveQuestionFromModal() {
    const typeSelect = document.getElementById('qm-type');
    const textInput  = document.getElementById('qm-text');

    const qType = typeSelect.value;
    const qText = textInput.value.trim();

    if (!qText) {
        textInput.style.borderColor = 'var(--hr-danger)';
        setTimeout(() => { textInput.style.borderColor = ''; }, 1500);
        return;
    }

    let options = [];
    let answer  = null;

    if (qType === 'single') {
        const optInputs = document.querySelectorAll('.hr-option-row input[type="text"]');
        const radios    = document.querySelectorAll('.hr-option-row input[type="radio"]');

        optInputs.forEach((inp, i) => {
            options.push(inp.value.trim() || `Option ${String.fromCharCode(65 + i)}`);
        });

        radios.forEach((r, i) => {
            if (r.checked) answer = i;
        });
    }

    const timeLimitInput = document.getElementById('qm-time-limit');
    const qTimeLimit = timeLimitInput ? parseInt(timeLimitInput.value, 10) || (qType === 'text' ? 1500 : 300) : (qType === 'text' ? 1500 : 300);

    const stored = getQuestions();
    const questions = (stored && stored.length > 0) ? stored : JSON.parse(JSON.stringify(defaultQuestions));

    const newQ = {
        id: currentEditIndex !== null ? (questions[currentEditIndex]?.id || Date.now()) : Date.now(),
        type: qType,
        text: qText,
        options,
        answer,
        timeLimit: qTimeLimit,
    };

    if (currentEditIndex !== null) {
        questions[currentEditIndex] = newQ;
        showHrToast('Question updated successfully!', 'success');
    } else {
        questions.push(newQ);
        showHrToast('Question added successfully!', 'success');
    }

    saveQuestions(questions);
    renderQuestionsPanel();
    closeAllModals();
}

// ─── Settings Panel ───────────────────────────────────────────────────────────
function renderSettings() {
    const maxWarnInput = document.getElementById('setting-max-warnings');
    if (maxWarnInput) maxWarnInput.value = getMaxWarnings();
}

function setupSettings() {
    const saveBtn = document.getElementById('btn-save-settings');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => {
            const val = parseInt(document.getElementById('setting-max-warnings').value, 10);
            if (val >= 1 && val <= 10) {
                saveMaxWarnings(val);
                showHrToast(`Max warnings set to ${val}.`, 'success');
            }
        });
    }

    const resetQuestionsBtn = document.getElementById('btn-reset-questions');
    if (resetQuestionsBtn) {
        resetQuestionsBtn.addEventListener('click', () => {
            if (!confirm('Reset all questions to defaults? This will overwrite your custom questions.')) return;
            saveQuestions(JSON.parse(JSON.stringify(defaultQuestions)));
            renderQuestionsPanel();
            showHrToast('Questions reset to defaults.', 'info');
        });
    }
}

function setupClearData() {
    const clearBtn = document.getElementById('btn-clear-students');
    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (!confirm('Clear ALL student session data? This cannot be undone.')) return;
            clearAllStudents();
            localStorage.removeItem('hr_blocked_ids');
            renderDashboard();
            renderStudentsTable();
            showHrToast('All student data cleared.', 'info');
        });
    }
}

// ─── Toast Notifications ──────────────────────────────────────────────────────
function showHrToast(message, type = 'info') {
    let container = document.getElementById('hr-toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'hr-toast-container';
        document.body.appendChild(container);
    }

    const icons = { success: '✅', error: '🚫', info: 'ℹ️' };
    const toast = document.createElement('div');
    toast.className = `hr-toast ${type}`;
    toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${escHtml(message)}</span>`;
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 350);
    }, 3500);
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function getViolationEmoji(type) {
    const map = {
        tab_switch: '🔁', window_blur: '🖱️', mouse_leave: '↗️',
        fullscreen_exit: '⛶', noise: '🔊', no_person: '👤',
        multiple_people: '👥', cell_phone: '📱', gaze_away: '👁️',
        copy_paste: '📋', devtools: '🛠️', screenshot: '📸',
        blocked: '🚫', screen_stopped: '🖥️',
    };
    return map[type] || '⚠️';
}
