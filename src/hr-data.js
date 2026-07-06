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
    let updatedSession = {};
    if (idx >= 0) {
        all[idx] = { ...all[idx], ...session };
        updatedSession = all[idx];
    } else {
        all.push(session);
        updatedSession = session;
    }
    writeJSON(KEYS.STUDENTS, all);
    syncStudentToRemote(updatedSession);
}

export function appendViolation(sessionId, violation) {
    const all = getAllStudents();
    const student = all.find(s => s.sessionId === sessionId);
    if (student) {
        student.violations = student.violations || [];
        student.violations.push(violation);
        writeJSON(KEYS.STUDENTS, all);
        syncStudentToRemote(student);
    }
}

export function updateStudentStatus(sessionId, status, extra = {}) {
    const all = getAllStudents();
    const student = all.find(s => s.sessionId === sessionId);
    if (student) {
        student.status = status;
        Object.assign(student, extra);
        writeJSON(KEYS.STUDENTS, all);
        syncStudentToRemote(student);
    }
}

export function clearAllStudents() {
    writeJSON(KEYS.STUDENTS, []);
    clearRemoteStudents();
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
        syncBlocklistToRemote(blocked);
    }
    updateStudentStatus(sessionId, 'blocked', { endTime: new Date().toISOString() });
}

export function unblockStudent(sessionId) {
    const blocked = getBlockedIds().filter(id => id !== sessionId);
    writeJSON(KEYS.BLOCKED, blocked);
    syncBlocklistToRemote(blocked);
    updateStudentStatus(sessionId, 'active');
}

// ─── Questions ────────────────────────────────────────────────────────────────

export function getQuestions() {
    return readJSON(KEYS.QUESTIONS, null);
}

export function saveQuestions(questions) {
    writeJSON(KEYS.QUESTIONS, questions);
    syncQuestionsToRemote(questions);
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

// ─── Remote Sync Functions (kvdb.io integration) ──────────────────────────────

const BUCKET_URL = 'https://kvdb.io/aifocused_proctor_db_x791a82';

export async function syncStudentToRemote(student) {
    try {
        await fetch(`${BUCKET_URL}/student_${student.sessionId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(student)
        });
    } catch (e) {
        console.error('Remote student sync failed:', e);
    }
}

export async function syncBlocklistToRemote(blocked) {
    try {
        await fetch(`${BUCKET_URL}/blocked_ids`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(blocked)
        });
    } catch (e) {
        console.error('Remote blocklist sync failed:', e);
    }
}

export async function syncQuestionsToRemote(questions) {
    try {
        await fetch(`${BUCKET_URL}/questions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(questions)
        });
    } catch (e) {
        console.error('Remote questions sync failed:', e);
    }
}

export async function syncAllFromRemote() {
    try {
        // 1. Fetch all student keys and values in one request
        const res = await fetch(`${BUCKET_URL}/?prefix=student_&values=true&format=json`);
        if (res.ok) {
            const data = await res.json(); // Array of [key, value]
            const students = data.map(item => {
                const val = item[1];
                return typeof val === 'string' ? JSON.parse(val) : val;
            });
            writeJSON(KEYS.STUDENTS, students);
        }

        // 2. Fetch blocklist
        const blockRes = await fetch(`${BUCKET_URL}/blocked_ids`);
        if (blockRes.ok) {
            const blocked = await blockRes.json();
            writeJSON(KEYS.BLOCKED, blocked);
        }

        // 3. Fetch questions
        const questionsRes = await fetch(`${BUCKET_URL}/questions`);
        if (questionsRes.ok) {
            const questions = await questionsRes.json();
            writeJSON(KEYS.QUESTIONS, questions);
        }
    } catch (e) {
        console.error('Failed to sync from remote database:', e);
    }
}

export async function clearRemoteStudents() {
    try {
        const res = await fetch(`${BUCKET_URL}/?prefix=student_&format=json`);
        if (res.ok) {
            const keys = await res.json();
            for (const key of keys) {
                await fetch(`${BUCKET_URL}/${key}`, { method: 'DELETE' }).catch(() => {});
            }
        }
        await fetch(`${BUCKET_URL}/blocked_ids`, { method: 'DELETE' }).catch(() => {});
    } catch (e) {
        console.error('Failed to clear remote data:', e);
    }
}
