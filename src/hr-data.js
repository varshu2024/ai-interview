/**
 * HR Data Layer — Shared localStorage module
 * Used by both the exam page (main.js) and the HR admin portal (hr-portal.js)
 * All cross-page state is stored as JSON in localStorage keys.
 */

// ─── Storage Keys ─────────────────────────────────────────────────────────────
export const KEYS = {
    STUDENTS:   'hr_students',          // Array<StudentSession>
    QUESTIONS:  'proctor_exam_questions', // Array<Question> (shared with exam page)
    BLOCKED:    'hr_blocked_ids',       // Set<string> (session IDs that are blocked)
    MAX_WARN:   'hr_max_warnings',      // number (violation threshold, default 4)
};

// ─── Student Session Schema ────────────────────────────────────────────────────
/**
 * @typedef {Object} StudentSession
 * @property {string}   sessionId     - Unique ID e.g. "SEC-ABC123"
 * @property {string}   name          - Student display name
 * @property {string}   startTime     - ISO timestamp
 * @property {string}   status        - 'active' | 'completed' | 'blocked'
 * @property {number}   score         - 0-100 percentage (null until completed)
 * @property {number}   totalQuestions
 * @property {number}   answered
 * @property {number}   correct
 * @property {Violation[]} violations
 * @property {string}   endTime       - ISO timestamp (null until ended)
 */

/**
 * @typedef {Object} Violation
 * @property {string} time    - HH:MM:SS
 * @property {string} type    - e.g. 'gaze_away', 'tab_switch'
 * @property {string} message
 * @property {string} severity - 'warning' | 'critical'
 */

// ─── Utility Helpers ───────────────────────────────────────────────────────────

function readJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function writeJSON(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        console.error('HR Data write error:', e);
    }
}

// ─── Students ─────────────────────────────────────────────────────────────────

export function getAllStudents() {
    return readJSON(KEYS.STUDENTS, []);
}

export function getStudent(sessionId) {
    return getAllStudents().find(s => s.sessionId === sessionId) || null;
}

export function upsertStudent(session) {
    const all = getAllStudents();
    const idx = all.findIndex(s => s.sessionId === session.sessionId);
    if (idx >= 0) {
        all[idx] = { ...all[idx], ...session };
    } else {
        all.push(session);
    }
    writeJSON(KEYS.STUDENTS, all);
}

export function appendViolation(sessionId, violation) {
    const all = getAllStudents();
    const student = all.find(s => s.sessionId === sessionId);
    if (student) {
        student.violations = student.violations || [];
        student.violations.push(violation);
        writeJSON(KEYS.STUDENTS, all);
    }
}

export function updateStudentStatus(sessionId, status, extra = {}) {
    const all = getAllStudents();
    const student = all.find(s => s.sessionId === sessionId);
    if (student) {
        student.status = status;
        Object.assign(student, extra);
        writeJSON(KEYS.STUDENTS, all);
    }
}

export function clearAllStudents() {
    writeJSON(KEYS.STUDENTS, []);
}

// ─── Block List ────────────────────────────────────────────────────────────────

export function getBlockedIds() {
    return readJSON(KEYS.BLOCKED, []);
}

export function isBlocked(sessionId) {
    return getBlockedIds().includes(sessionId);
}

export function blockStudent(sessionId) {
    const blocked = getBlockedIds();
    if (!blocked.includes(sessionId)) {
        blocked.push(sessionId);
        writeJSON(KEYS.BLOCKED, blocked);
    }
    updateStudentStatus(sessionId, 'blocked', { endTime: new Date().toISOString() });
}

export function unblockStudent(sessionId) {
    const blocked = getBlockedIds().filter(id => id !== sessionId);
    writeJSON(KEYS.BLOCKED, blocked);
    updateStudentStatus(sessionId, 'active');
}

// ─── Questions ────────────────────────────────────────────────────────────────

export function getQuestions() {
    return readJSON(KEYS.QUESTIONS, null);
}

export function saveQuestions(questions) {
    writeJSON(KEYS.QUESTIONS, questions);
}

// ─── Settings ─────────────────────────────────────────────────────────────────

export function getMaxWarnings() {
    const stored = localStorage.getItem(KEYS.MAX_WARN);
    return stored ? parseInt(stored, 10) : 4;
}

export function saveMaxWarnings(n) {
    localStorage.setItem(KEYS.MAX_WARN, String(n));
}

// ─── Generate Session ID ───────────────────────────────────────────────────────

export function generateSessionId() {
    return 'SEC-' + Array.from({ length: 20 }, () =>
        Math.floor(Math.random() * 16).toString(16)
    ).join('').toUpperCase();
}
