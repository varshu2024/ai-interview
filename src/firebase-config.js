import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

// Firebase Configuration using provided project details with environment overrides
const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyAh_BSV8-vWWqulzbIZsWE8nYQUD9GGHng",
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "ai-proctored-exam-90b53.firebaseapp.com",
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "ai-proctored-exam-90b53",
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "ai-proctored-exam-90b53.firebasestorage.app",
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "443369533376",
    appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:443369533376:web:d74cb19bb68903f624a225",
    measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-FZQ19P34K7"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);
