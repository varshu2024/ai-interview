# Project Documentation: AI-Proctored Secure Examination System

This document outlines the architecture, tech stack, AI modeling details, features implemented, and pros/cons of the **AI-Proctored Secure Examination System**.

---

## 1. Project Overview
The AI-Proctored Secure Examination System is a web-based client-server-less examination portal that ensures academic integrity during online tests. It monitors user behaviors using browser-native capabilities and client-side artificial intelligence models (machine learning object detection and custom computer vision algorithms). 

The application is structured into two main components:
1. **Exam Portal (`/index.html`)**: The interface where the candidate registers, grants hardware permissions (webcam, microphone, screen share, fullscreen), and completes the exam.
2. **HR Admin Portal (`/hr/index.html`)**: The real-time dashboard where the HR administrator manages questions, configures warnings thresholds, and monitors live student sessions, cheating violations, and captured screenshots.

---

## 2. Technology Stack

The application is designed using a lightweight, performant, and serverless client-side architecture:

| Component | Technology | Description |
| :--- | :--- | :--- |
| **Core Structure** | HTML5 / CSS3 / Vanilla JS (ES6+) | Native web components without heavy JS frameworks (Next.js/React) for maximum loading speed and compatibility. |
| **Build & Dev Tool** | Vite | Modern, fast front-end tooling to bundle modules and compile static assets. |
| **Data Layer** | LocalStorage | Local storage is used for data persistence and cross-tab syncing (`storage` events) between the candidate exam tab and the HR portal tab. |
| **AI Processing** | TensorFlow.js & COCO-SSD | Runs client-side object detection models in real-time in the browser. |
| **Audio Processing** | Web Audio API (AnalyserNode) | Real-time audio amplitude analysis to detect vocal noise without sending audio data to a server. |
| **Screen Share & Capture** | MediaDevices API | Native screen capture (`getDisplayMedia`) to verify full-desktop share and screenshot restrictions. |

---

## 3. AI Models & Computer Vision Algorithms

The proctoring system employs two distinct layers of AI monitoring running on the client:

### A. TensorFlow.js COCO-SSD Model
* **Model Type**: MobileNet v2 (lightweight backbone) trained on the COCO dataset.
* **Execution**: Runs client-side directly in the candidate's browser via a background loop.
* **Objects Monitored**:
  * **Candidate Absence**: Triggers a violation if `person` count is `0`.
  * **Secondary Persons**: Triggers a violation if `person` count is `> 1` (multiple faces).
  * **Mobile Phones**: Triggers an immediate lockout violation if a `cell phone` object is detected.

### B. Custom Eye-Gaze Tracking Engine
* **Method**: Pupil-Iris Pixel Luminance Analysis.
* **Execution**: Captures frames from the webcam at 500ms intervals, scales them down to `160x120` inside a memory-only canvas, and runs pixel-by-pixel brightness scans.
* **Gaze Direction Classification**:
  * **Center**: Iris dark pixels centered.
  * **Left / Right**: Iris dark pixels shifted horizontally (`deviationX > 15` or `deviationX < -15`).
  * **Looking Down**: Iris dark pixels shifted vertically downwards (`deviationY > 7.5`).
  * **Face Absent / Eyes Closed**: Insufficient dark pixels found in the eye region (`darkPixelCount < 5`).

---

## 4. Implemented Features

### 1. Dynamic Question-Level Timings
- Added a `timeLimit` parameter to all questions (defaulting to 300s for multiple-choice and 1500s for written design questions).
- Extended the **Question Modal** in the HR Admin portal with a "Time Limit (seconds)" number input, saving it to LocalStorage.
- Displayed a stopwatch badge (e.g. `⏱️ 300s`) next to each question on the HR panel list.
- Configured the candidate's exam timer to calculate the total exam duration dynamically by summing the time limits of all active questions.

### 2. Looking Down Gaze Detection & Warning System
- Implemented vertical pupil tracking (`deviationY`) inside the gaze engine.
- Added a continuous looking-down tick counter. To prevent false positives, a warning is only sent after **2 minutes** (240 ticks) of continuous down-gaze.
- If looking down persists, warnings are fired every **30 seconds** (60 ticks) up to a hard cap of **5 warnings**.
- Looking back at the screen immediately resets the safety timer.
- Added styled visual indicators for looking down on both portals.

### 3. Conditional Lockouts (Warning-Only Mode)
- Changed the lockout policy so that candidates are only locked out of the exam when a **mobile phone (`cell_phone`)** is detected by the AI.
- For all other violations (tab switches, looking left/right/down, loud noise, face absent), the system issues a warning toast, increments the strike meter, and logs it, but allows the candidate to continue the exam.

### 4. Gaze Violation Screenshot Captures
- Added a high-performance canvas snapshot helper that captures a frame from the candidate's webcam feed upon a gaze violation (`gaze_away` or `gaze_down`).
- Compresses the image as a JPEG Data URL at `0.5` quality (averaging ~4KB) to stay within browser storage limits.
- Stamped each screenshot with a red `VIOLATION STAMP` watermark and time.
- Integrated the screenshots directly into the HR Admin Portal inside each candidate's expandable violation drawer.

---

## 5. Pros and Cons of Browser-Client Proctoring

### Pros
1. **Absolute Privacy**: No video, audio, or personal details are uploaded to a remote server. All machine learning inference and video streams remain local.
2. **Zero Server Costs**: Running models client-side avoids expensive cloud GPU costs, making the application infinitely scalable.
3. **Real-Time Responsiveness**: Violations are flagged within milliseconds since there is no network round-trip latency.
4. **Low Bandwidth Requirements**: The exam can be taken on slow internet connections since only text statistics (and small violation logs) are synchronized.
5. **No App Installs**: Candidates can take the exam instantly in standard modern web browsers (Chrome, Edge, Firefox, Safari) without installing invasive desktop software.

### Cons
1. **Vulnerable to Browser Interruption**: A candidate can intentionally force-close the tab or disable their webcam, which must be logged as a critical interruption.
2. **Device Performance Dependent**: Lightweight models (like MobileNet) must be used. Older computers with weak CPUs/GPUs may experience lag during real-time image analysis.
3. **Canvas Capture Limitations**: Canvas captures are limited by webcam resolution and hardware framing (e.g., poor room lighting can degrade gaze tracking accuracy).
4. **LocalStorage Size Cap**: Using LocalStorage restricts the total session data (including base64 screenshots) to a 5MB limit.

---

## 6. Future Recommendations
- **IndexedDB Migration**: Move session logs from LocalStorage to IndexedDB to eliminate the 5MB storage limit and allow unlimited screenshot storage.
- **Server Syncing Integration**: Connect the client-side data layer to a secure backend (e.g., Firebase, Node.js) for persistent remote reporting.
- **Face Mesh Model**: Upgrade the gaze tracking engine to a lightweight Mediapipe Face Mesh model to track eye movement with sub-pixel precision under varied lighting conditions.
