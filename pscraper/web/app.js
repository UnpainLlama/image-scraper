const loginScreen = document.querySelector("#login-screen");
const loginForm = document.querySelector("#login-form");
const passwordInput = document.querySelector("#password");
const loginError = document.querySelector("#login-error");
const terminalScreen = document.querySelector("#terminal-screen");
const terminalOutput = document.querySelector("#terminal-output");
const terminalForm = document.querySelector("#terminal-form");
const terminalInput = document.querySelector("#terminal-input");
const terminalState = document.querySelector("#terminal-state");

let socket = null;
let rendered = "";
let connecting = false;

function showTerminal() {
  loginScreen.hidden = true;
  terminalScreen.hidden = false;
  terminalInput.focus();
  connectTerminal();
}

function showLogin(message = "") {
  terminalScreen.hidden = true;
  loginScreen.hidden = false;
  loginError.textContent = message;
  passwordInput.value = "";
  passwordInput.focus();
}

function renderText(chunk) {
  for (const char of chunk) {
    if (char === "\r") {
      const lastBreak = rendered.lastIndexOf("\n");
      rendered = rendered.slice(0, lastBreak + 1);
    } else if (char === "\b") {
      rendered = rendered.slice(0, -1);
    } else {
      rendered += char;
    }
  }
  if (rendered.length > 400000) rendered = rendered.slice(-300000);
  terminalOutput.textContent = rendered;
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function connectTerminal() {
  if (connecting || (socket && socket.readyState <= WebSocket.OPEN)) return;
  connecting = true;
  terminalInput.disabled = true;
  terminalState.textContent = "connecting";
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(scheme + "//" + location.host + "/api/terminal");
  socket.addEventListener("open", () => {
    connecting = false;
    terminalInput.disabled = false;
    terminalState.textContent = "connected";
    terminalInput.focus();
  });
  socket.addEventListener("message", (event) => renderText(String(event.data)));
  socket.addEventListener("close", (event) => {
    connecting = false;
    terminalState.textContent = event.code === 1013 ? "terminal busy" : "connection closed";
    terminalInput.disabled = true;
  });
  socket.addEventListener("error", () => {
    connecting = false;
    terminalState.textContent = "connection error";
  });
}

async function checkAuth() {
  try {
    const response = await fetch("/api/auth/status", { credentials: "same-origin", cache: "no-store" });
    const result = await response.json();
    if (result.authenticated) {
      showTerminal();
      return;
    }
    showLogin("");
  } catch {
    showLogin("");
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const password = passwordInput.value;
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ password }),
    });
    const result = await response.json();
    if (!response.ok || !result.authenticated) {
      loginError.textContent = response.status === 429 ? "Try again later" : response.status === 503 ? "Password login is not configured" : "Incorrect password";
      passwordInput.select();
      return;
    }
    showTerminal();
  } catch {
    loginError.textContent = "Connection unavailable";
  }
});

terminalForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = terminalInput.value;
  if (!socket || socket.readyState !== WebSocket.OPEN || terminalInput.disabled) return;
  renderText(value + "\n");
  socket.send(JSON.stringify({ type: "input", data: value + "\n" }));
  terminalInput.value = "";
});

terminalInput.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === "c") {
    event.preventDefault();
    if (socket?.readyState === WebSocket.OPEN) {
      renderText("^C\n");
      socket.send(JSON.stringify({ type: "interrupt" }));
    }
  }
  if (event.ctrlKey && event.key.toLowerCase() === "l") {
    event.preventDefault();
    rendered = "";
    terminalOutput.textContent = "";
  }
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "l") {
    event.preventDefault();
    fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).finally(() => {
      socket?.close();
      socket = null;
      rendered = "";
      terminalOutput.textContent = "";
      terminalInput.disabled = false;
      showLogin();
    });
  }
});

window.addEventListener("beforeunload", () => {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
});

checkAuth();
