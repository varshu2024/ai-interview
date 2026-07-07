import { questions as defaultQuestions } from './questions.js';
import { db, storage } from './firebase-config.js';
import { doc, setDoc, updateDoc, getDoc, collection, getDocs, deleteDoc, arrayUnion, writeBatch, onSnapshot, addDoc } from 'firebase/firestore';
import { ref, uploadString, getDownloadURL } from 'firebase/storage';

let studentsData = [];
let examsData = [];
let violationsData = [];

/**
 * HR Data Layer — Shared localStorage module
 * Used by both the exam page (main.js) and the HR admin portal (hr-portal.js)
 * All cross-page state is stored as JSON in localStorage keys.
 */

// ─── Storage Keys ─────────────────────────────────────────────────────────────
export const KEYS = {
    STUDENTS:      'hr_students',           // Array<StudentSession>
    QUESTIONS:     'proctor_exam_questions', // Array<Question> (shared with exam page)
    BLOCKED:       'hr_blocked_ids',        // Set<string> (session IDs that are blocked)
    MAX_WARN:      'hr_max_warnings',       // number (violation threshold, default 4)
    EXAM_DURATION: 'hr_exam_duration',      // number (total exam duration in minutes, default 30)
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
        writeJSON(KEYS.STUDENTS, all);
        // Since it exists, we can use the update route to prevent massive payloads
        syncStudentUpdateToRemote(session);
    } else {
        all.push(session);
        updatedSession = session;
        writeJSON(KEYS.STUDENTS, all);
        // Use register for new candidates
        syncStudentToRemote(updatedSession);
    }
}

export function appendViolation(sessionId, violation) {
    const all = getAllStudents();
    const student = all.find(s => s.sessionId === sessionId);
    if (student) {
        student.violations = student.violations || [];
        student.violations.push(violation);
        writeJSON(KEYS.STUDENTS, all);
        syncViolationToRemote(sessionId, violation);
    }
}

export function updateStudentStatus(sessionId, status, extra = {}) {
    const all = getAllStudents();
    const student = all.find(s => s.sessionId === sessionId);
    if (student) {
        student.status = status;
        Object.assign(student, extra);
        writeJSON(KEYS.STUDENTS, all);
        syncStudentUpdateToRemote(Object.assign({ sessionId, status }, extra));
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

export async function blockStudent(sessionId) {
    const blocked = getBlockedIds();
    if (!blocked.includes(sessionId)) {
        blocked.push(sessionId);
        writeJSON(KEYS.BLOCKED, blocked);
    }
    updateStudentStatus(sessionId, 'blocked', { endTime: new Date().toISOString() });
    
    try {
        await fetch(`${API_BASE}/api/hr/block`, {
            method: 'POST',
            headers: getHrHeaders(),
            body: JSON.stringify({ sessionId })
        });
    } catch (e) {
        console.error('Failed to block student remotely:', e);
    }
}

export async function unblockStudent(sessionId) {
    const blocked = getBlockedIds().filter(id => id !== sessionId);
    writeJSON(KEYS.BLOCKED, blocked);
    updateStudentStatus(sessionId, 'active');

    try {
        await fetch(`${API_BASE}/api/hr/unblock`, {
            method: 'POST',
            headers: getHrHeaders(),
            body: JSON.stringify({ sessionId })
        });
    } catch (e) {
        console.error('Failed to unblock student remotely:', e);
    }
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
    syncSettingsToServer();
}

/**
 * getExamDuration — Total exam time limit in MINUTES (set by HR).
 * Returns 0 if not set (0 = use per-question time limits from questions).
 */
export function getExamDuration() {
    const stored = localStorage.getItem(KEYS.EXAM_DURATION);
    return stored ? parseInt(stored, 10) : 0;
}

export async function saveExamDuration(minutes) {
    localStorage.setItem(KEYS.EXAM_DURATION, String(minutes));
    await syncSettingsToServer();
}

export async function syncSettingsToServer() {
    try {
        const maxWarnings = getMaxWarnings();
        const examDuration = getExamDuration();
        await setDoc(doc(db, "settings", "config"), {
            maxWarnings,
            examDuration
        }, { merge: true });
    } catch (e) {
        console.error('Remote settings sync failed:', e);
    }
}

// ─── Generate Session ID ───────────────────────────────────────────────────────

export function generateSessionId() {
    return 'SEC-' + Array.from({ length: 20 }, () =>
        Math.floor(Math.random() * 16).toString(16)
    ).join('').toUpperCase();
}

// ─── Remote Sync Functions (Firebase Firestore integration) ───────────────────

export async function uploadScreenshot(studentId, base64Data) {
    if (!base64Data || !base64Data.startsWith('data:')) {
        return base64Data;
    }
    try {
        const storageRef = ref(storage, `screenshots/${studentId}/${Date.now()}.jpg`);
        const uploadResult = await uploadString(storageRef, base64Data, 'data_url');
        return await getDownloadURL(uploadResult.ref);
    } catch (e) {
        console.error("Firebase Storage screenshot upload failed, falling back to base64 inline data:", e);
        return base64Data;
    }
}

function getWarningCountForStudent(sessionId) {
    const student = getStudent(sessionId);
    return student && student.violations ? student.violations.length : 0;
}

export async function syncStudentToRemote(student) {
    try {
        const studentId = student.sessionId;
        
        // 1. Write to "students" collection
        await setDoc(doc(db, "students", studentId), {
            studentId,
            fullName: student.name || '',
            email: student.email || '',
            phone: student.phone || '',
            college: student.college || student.location || '',
            registeredAt: student.registeredAt || new Date().toISOString()
        });

        // 2. Write to "exams" collection
        await setDoc(doc(db, "exams", studentId), {
            studentId,
            examId: studentId,
            answers: student.answers || {},
            score: student.score || null,
            startTime: student.startTime || new Date().toISOString(),
            submitTime: student.endTime || null,
            status: student.status || 'active'
        });
    } catch (e) {
        console.error('Remote student registration failed:', e);
    }
}

export async function syncStudentUpdateToRemote(updates) {
    try {
        const studentId = updates.sessionId;
        const examFields = {};
        
        if (updates.status) examFields.status = updates.status;
        if (updates.score !== undefined) examFields.score = updates.score;
        if (updates.endTime) examFields.submitTime = updates.endTime;
        if (updates.answers) examFields.answers = updates.answers;

        if (Object.keys(examFields).length > 0) {
            await setDoc(doc(db, "exams", studentId), examFields, { merge: true });
        }
    } catch (e) {
        console.error('Remote student update failed:', e);
    }
}

export async function syncViolationToRemote(sessionId, violation) {
    try {
        const warningCount = getWarningCountForStudent(sessionId);
        
        // 1. Upload screenshot to Firebase Storage
        const screenshotUrl = await uploadScreenshot(sessionId, violation.screenshot || '');
        
        // 2. Save violation record in Firestore
        await addDoc(collection(db, "violations"), {
            studentId: sessionId,
            violationType: violation.type || '',
            screenshot: screenshotUrl,
            timestamp: new Date().toISOString(),
            warningCount: warningCount
        });
        
        // If phone detection violation, automatically block on Firestore
        if (violation.type === 'cell_phone') {
            const blocked = getBlockedIds();
            if (!blocked.includes(sessionId)) {
                blocked.push(sessionId);
                writeJSON(KEYS.BLOCKED, blocked);
            }
            await setDoc(doc(db, "settings", "config"), {
                blocked_ids: blocked
            }, { merge: true });
        }
    } catch (e) {
        console.error('Remote violation sync failed:', e);
    }
}

export async function syncBlocklistToRemote(blocked) {
    // Handled directly inside blockStudent / unblockStudent
}

export async function syncQuestionsToRemote(questions) {
    try {
        await setDoc(doc(db, "settings", "questions"), { list: questions });
    } catch (e) {
        console.error('Remote questions sync failed:', e);
    }
}

export async function syncAllFromRemote() {
    try {
        // 1. Fetch Students
        const studentsSnapshot = await getDocs(collection(db, "students"));
        studentsData = [];
        studentsSnapshot.forEach(doc => studentsData.push(doc.data()));

        // 2. Fetch Exams
        const examsSnapshot = await getDocs(collection(db, "exams"));
        examsData = [];
        examsSnapshot.forEach(doc => examsData.push(doc.data()));

        // 3. Fetch Violations
        const violationsSnapshot = await getDocs(collection(db, "violations"));
        violationsData = [];
        violationsSnapshot.forEach(doc => violationsData.push(doc.data()));

        // 4. Merge and write to local storage
        const merged = studentsData.map(student => {
            const exam = examsData.find(e => e.studentId === student.studentId) || null;
            const studentViolations = violationsData
                .filter(v => v.studentId === student.studentId)
                .map(v => ({
                    type: v.violationType,
                    message: `Violation detected: ${v.violationType}`,
                    time: v.timestamp ? new Date(v.timestamp).toLocaleTimeString() : '',
                    severity: v.violationType === 'cell_phone' ? 'critical' : 'warning',
                    screenshot: v.screenshot || ''
                }));

            return {
                sessionId: student.studentId,
                name: student.fullName,
                email: student.email,
                phone: student.phone,
                location: student.college || '',
                date: student.registeredAt ? new Date(student.registeredAt).toLocaleDateString() : '',
                status: exam ? exam.status : 'pending',
                score: exam ? exam.score : null,
                startTime: exam ? exam.startTime : null,
                endTime: exam ? exam.submitTime : null,
                totalQuestions: exam && exam.answers ? Object.keys(exam.answers).length : 0,
                answered: exam && exam.answers ? Object.keys(exam.answers).filter(k => exam.answers[k] !== null).length : 0,
                violations: studentViolations
            };
        });
        writeJSON(KEYS.STUDENTS, merged);

        // 5. Fetch config (blocked_ids and settings)
        const configDoc = await getDoc(doc(db, "settings", "config"));
        if (configDoc.exists()) {
            const configData = configDoc.data();
            if (configData.blocked_ids) {
                writeJSON(KEYS.BLOCKED, configData.blocked_ids);
            }
            if (typeof configData.maxWarnings === 'number') {
                localStorage.setItem(KEYS.MAX_WARN, String(configData.maxWarnings));
            }
            if (typeof configData.examDuration === 'number') {
                localStorage.setItem(KEYS.EXAM_DURATION, String(configData.examDuration));
            }
        }

        // 6. Fetch questions
        const questionsDoc = await getDoc(doc(db, "settings", "questions"));
        if (questionsDoc.exists()) {
            const qData = questionsDoc.data();
            if (qData.list && Array.isArray(qData.list) && qData.list.length > 0) {
                writeJSON(KEYS.QUESTIONS, qData.list);
            } else {
                writeJSON(KEYS.QUESTIONS, defaultQuestions);
                await syncQuestionsToRemote(defaultQuestions);
            }
        } else {
            writeJSON(KEYS.QUESTIONS, defaultQuestions);
            await syncQuestionsToRemote(defaultQuestions);
        }
    } catch (e) {
        console.error('Failed to sync from Firestore remote database:', e);
    }
}

export async function clearRemoteStudents() {
    try {
        const batch = writeBatch(db);
        
        // Delete all students
        const studentsSnapshot = await getDocs(collection(db, "students"));
        studentsSnapshot.forEach((doc) => {
            batch.delete(doc.ref);
        });

        // Delete all exams
        const examsSnapshot = await getDocs(collection(db, "exams"));
        examsSnapshot.forEach((doc) => {
            batch.delete(doc.ref);
        });

        // Delete all violations
        const violationsSnapshot = await getDocs(collection(db, "violations"));
        violationsSnapshot.forEach((doc) => {
            batch.delete(doc.ref);
        });

        // Reset blocked_ids
        batch.set(doc(db, "settings", "config"), { blocked_ids: [] }, { merge: true });

        await batch.commit();

        studentsData = [];
        examsData = [];
        violationsData = [];
    } catch (e) {
        console.error('Failed to clear remote data in Firestore:', e);
    }
}

// ─── Real-Time Firestore Document Observers ───────────────────────────────────

export function subscribeToStudents(callback) {
    let unsubStudents = () => {};
    let unsubExams = () => {};
    let unsubViolations = () => {};

    const triggerMerge = () => {
        const merged = studentsData.map(student => {
            const exam = examsData.find(e => e.studentId === student.studentId) || null;
            const studentViolations = violationsData
                .filter(v => v.studentId === student.studentId)
                .map(v => ({
                    type: v.violationType,
                    message: `Violation detected: ${v.violationType}`,
                    time: v.timestamp ? new Date(v.timestamp).toLocaleTimeString() : '',
                    severity: v.violationType === 'cell_phone' ? 'critical' : 'warning',
                    screenshot: v.screenshot || ''
                }));

            return {
                sessionId: student.studentId,
                name: student.fullName,
                email: student.email,
                phone: student.phone,
                location: student.college || '',
                date: student.registeredAt ? new Date(student.registeredAt).toLocaleDateString() : '',
                status: exam ? exam.status : 'pending',
                score: exam ? exam.score : null,
                startTime: exam ? exam.startTime : null,
                endTime: exam ? exam.submitTime : null,
                totalQuestions: exam && exam.answers ? Object.keys(exam.answers).length : 0,
                answered: exam && exam.answers ? Object.keys(exam.answers).filter(k => exam.answers[k] !== null).length : 0,
                violations: studentViolations
            };
        });
        
        writeJSON(KEYS.STUDENTS, merged);
        callback(merged);
    };

    unsubStudents = onSnapshot(collection(db, "students"), (snapshot) => {
        studentsData = [];
        snapshot.forEach(doc => studentsData.push(doc.data()));
        triggerMerge();
    }, err => console.error("Students subscribe error:", err));

    unsubExams = onSnapshot(collection(db, "exams"), (snapshot) => {
        examsData = [];
        snapshot.forEach(doc => examsData.push(doc.data()));
        triggerMerge();
    }, err => console.error("Exams subscribe error:", err));

    unsubViolations = onSnapshot(collection(db, "violations"), (snapshot) => {
        violationsData = [];
        snapshot.forEach(doc => violationsData.push(doc.data()));
        triggerMerge();
    }, err => console.error("Violations subscribe error:", err));

    return () => {
        unsubStudents();
        unsubExams();
        unsubViolations();
    };
}

export function subscribeToConfig(callback) {
    return onSnapshot(doc(db, "settings", "config"), (snapshot) => {
        if (snapshot.exists()) {
            const configData = snapshot.data();
            if (configData.blocked_ids) {
                writeJSON(KEYS.BLOCKED, configData.blocked_ids);
            }
            if (typeof configData.maxWarnings === 'number') {
                localStorage.setItem(KEYS.MAX_WARN, String(configData.maxWarnings));
            }
            if (typeof configData.examDuration === 'number') {
                localStorage.setItem(KEYS.EXAM_DURATION, String(configData.examDuration));
            }
            callback(configData);
        }
    }, (error) => {
        console.error("Error listening to config:", error);
    });
}

// ─── Window Exposed Password Verify Helpers for HR Login Gate ──────────────────

window.verifyHrPassword = async function(password) {
    try {
        const configDoc = await getDoc(doc(db, "settings", "config"));
        let correctPassword = "123456789"; // Default
        if (configDoc.exists()) {
            const data = configDoc.data();
            if (data.hr_password) {
                correctPassword = data.hr_password;
            }
        }
        return password === correctPassword;
    } catch (e) {
        console.error("Password verification error:", e);
        return false;
    }
};

window.updateHrPassword = async function(newPassword) {
    try {
        await setDoc(doc(db, "settings", "config"), {
            hr_password: newPassword
        }, { merge: true });
        return true;
    } catch (e) {
        console.error("Password update error:", e);
        return false;
    }
};

