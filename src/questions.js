export const questions = [
  {
    id: 1,
    type: "single",
    text: "Which of the following descriptions best defines a Closure in JavaScript?",
    options: [
      "A function that is executed immediately after its creation, bypassing the normal execution stack.",
      "A method of copying variables by reference rather than by value inside asynchronous loops.",
      "The combination of a function bundled together with references to its lexical environment, allowing it to access outer scope variables even after the outer function has returned.",
      "A security mechanism that prevents external scripts from modifying local variables of a given function."
    ],
    answer: 2
  },
  {
    id: 2,
    type: "single",
    text: "In systems engineering, what does the CAP Theorem state about distributed databases?",
    options: [
      "A system can guarantee Capacity, Availability, and Portability at the same time.",
      "A system can provide at most two of three guarantees: Consistency, Availability, and Partition Tolerance.",
      "Concurrency, Atomicity, and Performance are inversely proportional.",
      "Calculated memory limits, Allocated CPU cycles, and Peak read-rates must remain balanced."
    ],
    answer: 1
  },
  {
    id: 3,
    type: "single",
    text: "What is the difference between microtasks (e.g., Promise.then) and macrotasks (e.g., setTimeout) in the JavaScript Event Loop?",
    options: [
      "Macrotasks are executed immediately before the rendering step, while microtasks are deferred to the next frame tick.",
      "Microtasks have higher priority and the entire microtask queue is cleared completely before the event loop proceeds to run the next macrotask.",
      "There is no functional difference; they are executed sequentially in the order they are registered in the global execution context.",
      "Macrotasks are executed in parallel using Web Workers, while microtasks run strictly on the main single thread."
    ],
    answer: 1
  },
  {
    id: 4,
    type: "single",
    text: "Which HTTP status code is used for 'Payload Too Large', when a request is larger than the server is willing or able to process?",
    options: [
      "413 Payload Too Large",
      "429 Too Many Requests",
      "404 Not Found",
      "503 Service Unavailable"
    ],
    answer: 0
  },
  {
    id: 5,
    type: "text",
    text: "Explain how you would optimize a web application that suffers from slow initial load times and high latency. (Write your technical design proposal below)",
    options: [], // Text question has no pre-defined multiple choice options
    answer: null
  }
];
