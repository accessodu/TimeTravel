// Copy this file to `secret.local.js` (same folder) and fill in your own key.
// `secret.local.js` is .gitignored and must NEVER be committed.
// A free Groq key is available at https://console.groq.com
//
//   cp secret.local.example.js secret.local.js   # then edit the line below

self.__AI_PROVIDER__ = 'groq';                 // 'groq' (cloud llama-3.1-8b-instant) | 'ollama' (local)
self.__AI_KEY__      = 'YOUR_GROQ_API_KEY_HERE';
