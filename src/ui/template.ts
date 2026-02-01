import * as vscode from 'vscode';

export function getForgeHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  const csp =
    "default-src 'none'; " +
    `img-src ${webview.cspSource} data:; ` +
    `style-src ${webview.cspSource} 'unsafe-inline'; ` +
    `script-src 'nonce-${nonce}';`;

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Forge</title>
    <style>
      :root {
        --bg: #0b0f14;
        --bg-soft: #131a22;
        --panel: #0f141b;
        --panel-2: #151d27;
        --ink: #e6edf3;
        --muted: #9fb0c2;
        --accent: #3dd6a1;
        --accent-2: #4db8ff;
        --border: rgba(255, 255, 255, 0.08);
        --shadow: rgba(5, 8, 12, 0.5);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        font-family: "Fira Sans", "Segoe UI", sans-serif;
        color: var(--ink);
        background: radial-gradient(circle at 20% 0%, #15202b, transparent 45%),
          radial-gradient(circle at 80% 0%, #0f1f2e, transparent 40%),
          linear-gradient(145deg, #0a0f15, #0b121a);
        min-height: 100vh;
      }

      .shell {
        height: 100vh;
        display: flex;
        flex-direction: column;
        padding: 24px 20px 20px;
        width: 100%;
        margin: 0 auto;
        animation: fadeUp 0.6s ease-out;
      }

      .hero {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        margin-bottom: 18px;
      }

      .title {
        font-size: 28px;
        letter-spacing: 0.3px;
      }

      .subtitle {
        color: var(--muted);
        margin-top: 4px;
        font-size: 13px;
      }

      .active-file {
        margin-top: 6px;
        font-size: 12px;
        color: #c8d4e3;
        background: rgba(77, 184, 255, 0.12);
        border: 1px solid rgba(77, 184, 255, 0.25);
        padding: 4px 10px;
        border-radius: 999px;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }

      .active-file span {
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 1px;
        font-size: 10px;
      }

      .badge {
        background: linear-gradient(135deg, var(--accent), #1dd3b0);
        color: #0a0f15;
        padding: 6px 14px;
        border-radius: 999px;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 1px;
        box-shadow: 0 10px 30px rgba(61, 214, 161, 0.2);
      }

      .card {
        background: linear-gradient(180deg, var(--panel), var(--panel-2));
        border-radius: 18px;
        padding: 18px;
        box-shadow: 0 20px 40px var(--shadow);
        border: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;
      }

      .chat {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .message {
        max-width: 82%;
        padding: 10px 12px;
        border-radius: 14px;
        font-size: 13px;
        line-height: 1.4;
        border: 1px solid var(--border);
        white-space: pre-wrap;
      }

      .message.user {
        align-self: flex-end;
        background: rgba(77, 184, 255, 0.15);
        color: #d9efff;
        border-color: rgba(77, 184, 255, 0.35);
      }

      .message.assistant {
        align-self: flex-start;
        background: rgba(61, 214, 161, 0.12);
        color: #d5fff2;
        border-color: rgba(61, 214, 161, 0.35);
      }

      .message.diff {
        align-self: stretch;
        background: rgba(15, 23, 42, 0.85);
        border-color: rgba(148, 163, 184, 0.25);
        color: #d5dde7;
        font-family: "Consolas", "Courier New", monospace;
        font-size: 12px;
      }

      .diff-line {
        display: block;
        padding: 2px 4px;
        border-radius: 6px;
      }

      .diff-line.add {
        color: #7ee787;
        background: rgba(46, 160, 67, 0.15);
      }

      .diff-line.remove {
        color: #ff7b72;
        background: rgba(248, 81, 73, 0.15);
      }

      .diff-line.context {
        color: var(--muted);
      }

      .message.system {
        align-self: center;
        background: rgba(255, 255, 255, 0.08);
        color: var(--muted);
        border-color: rgba(255, 255, 255, 0.12);
        font-size: 12px;
      }

      .composer {
        margin-top: 16px;
        display: flex;
        gap: 10px;
        align-items: flex-end;
      }

      textarea {
        width: 100%;
        min-height: 80px;
        border-radius: 12px;
        border: 1px solid var(--border);
        padding: 12px;
        font-size: 14px;
        font-family: "Fira Sans", "Segoe UI", sans-serif;
        background: var(--bg-soft);
        resize: vertical;
        color: var(--ink);
      }

      textarea:focus {
        outline: 1px solid rgba(77, 184, 255, 0.4);
      }

      .actions {
        display: flex;
        gap: 10px;
        flex-direction: column;
      }

      button {
        border: none;
        border-radius: 12px;
        padding: 10px 16px;
        font-size: 13px;
        cursor: pointer;
        transition: transform 0.2s ease, box-shadow 0.2s ease;
      }

      .primary {
        background: linear-gradient(135deg, var(--accent), #22d3ee);
        color: #08121a;
        box-shadow: 0 10px 24px rgba(34, 211, 238, 0.2);
      }

      .ghost {
        background: transparent;
        color: var(--muted);
        border: 1px solid var(--border);
      }

      button:hover {
        transform: translateY(-1px);
      }

      .status {
        margin-top: 12px;
        font-size: 12px;
        color: var(--muted);
      }

      .modal {
        position: fixed;
        inset: 0;
        background: rgba(2, 6, 12, 0.7);
        display: none;
        align-items: center;
        justify-content: center;
        padding: 24px;
        z-index: 20;
      }

      .modal.show {
        display: flex;
      }

      .modal-card {
        width: min(760px, 90vw);
        max-height: 80vh;
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: 0 20px 40px var(--shadow);
        display: flex;
        flex-direction: column;
        padding: 16px;
      }

      .modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 10px;
      }

      .modal-title {
        font-size: 14px;
        color: var(--ink);
      }

      .modal-search {
        width: 100%;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: var(--bg-soft);
        color: var(--ink);
        padding: 8px 10px;
        font-size: 13px;
        margin-bottom: 12px;
      }

      .file-list {
        overflow: auto;
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 8px;
        background: rgba(10, 15, 20, 0.5);
        flex: 1;
      }

      .file-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 6px;
        border-radius: 8px;
        font-size: 12px;
      }

      .file-item:hover {
        background: rgba(148, 163, 184, 0.12);
      }

      .modal-actions {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-top: 12px;
      }

      .selection-count {
        font-size: 12px;
        color: var(--muted);
      }

      @keyframes fadeUp {
        from {
          opacity: 0;
          transform: translateY(12px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      @media (max-width: 720px) {
        .hero {
          flex-direction: column;
          align-items: flex-start;
        }

        .composer {
          flex-direction: column;
        }

        .actions {
          flex-direction: row;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="hero">
        <div>
          <div class="title">Forge</div>
          <div class="subtitle">On-prem copilot workflow. Local edits with strict control.</div>
          <div class="active-file">
            <span>Active</span>
            <strong id="active-file-name">None</strong>
          </div>
        </div>
        <div class="badge">On-Prem</div>
      </div>

      <div class="card">
        <div class="chat" id="chat"></div>
        <div class="composer">
          <textarea id="prompt" placeholder="Ask Forge to change the active file..."></textarea>
          <div class="actions">
            <button class="primary" id="run">Send</button>
            <button class="ghost" id="clear">Clear</button>
          </div>
        </div>
        <div class="status" id="status">Idle</div>
      </div>
    </div>

    <div class="modal" id="file-modal">
      <div class="modal-card">
        <div class="modal-header">
          <div class="modal-title">Select files to edit</div>
        </div>
        <input id="file-search" class="modal-search" placeholder="Search files..." />
        <div id="file-list" class="file-list"></div>
        <div class="modal-actions">
          <div class="selection-count" id="file-count">0 selected</div>
          <div>
            <button class="ghost" id="file-cancel">Cancel</button>
            <button class="primary" id="file-apply">Use Selected</button>
          </div>
        </div>
      </div>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const prompt = document.getElementById('prompt');
      const run = document.getElementById('run');
      const clear = document.getElementById('clear');
      const status = document.getElementById('status');
      const chat = document.getElementById('chat');
      const activeFileName = document.getElementById('active-file-name');
      const fileModal = document.getElementById('file-modal');
      const fileList = document.getElementById('file-list');
      const fileSearch = document.getElementById('file-search');
      const fileApply = document.getElementById('file-apply');
      const fileCancel = document.getElementById('file-cancel');
      const fileCount = document.getElementById('file-count');
      let currentFiles = [];
      let preselectedFiles = [];

      const addMessage = (role, text) => {
        if (!text) return;
        const message = document.createElement('div');
        message.className = 'message ' + role;
        message.textContent = text;
        chat.appendChild(message);
        chat.scrollTop = chat.scrollHeight;
      };

      const addDiff = (lines) => {
        if (!lines || !lines.length) return;
        const message = document.createElement('div');
        message.className = 'message diff';
        lines.forEach((line) => {
          const span = document.createElement('span');
          const kind = line.startsWith('+')
            ? 'add'
            : line.startsWith('-')
              ? 'remove'
              : 'context';
          span.className = 'diff-line ' + kind;
          span.textContent = line;
          message.appendChild(span);
        });
        chat.appendChild(message);
        chat.scrollTop = chat.scrollHeight;
      };

      run.addEventListener('click', () => {
        const text = prompt.value.trim();
        if (run.dataset.mode === 'stop') {
          status.textContent = 'Stopping...';
          run.textContent = 'Send';
          run.dataset.mode = 'send';
          vscode.postMessage({ type: 'stop' });
          return;
        }
        if (!text) {
          status.textContent = 'Enter an instruction first.';
          return;
        }
        status.textContent = 'Running...';
        run.textContent = 'Stop';
        run.dataset.mode = 'stop';
        addMessage('user', text);
        prompt.value = '';
        vscode.postMessage({ type: 'run', text });
      });

      prompt.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          run.click();
        }
      });

      clear.addEventListener('click', () => {
        prompt.value = '';
        status.textContent = 'Idle';
        chat.textContent = '';
        run.textContent = 'Send';
        run.dataset.mode = 'send';
        vscode.postMessage({ type: 'clear' });
      });

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'status') {
          status.textContent = message.text;
          if (message.text.toLowerCase().includes('stopped') || message.text.toLowerCase().includes('done')) {
            run.textContent = 'Send';
            run.dataset.mode = 'send';
          }
        }
        if (message.type === 'activeFile') {
          activeFileName.textContent = message.text;
        }
        if (message.type === 'log') {
          addMessage('assistant', message.text);
        }
        if (message.type === 'diff') {
          addDiff(message.lines || []);
        }
        if (message.type === 'fileSelection') {
          currentFiles = Array.isArray(message.files) ? message.files : [];
          preselectedFiles = Array.isArray(message.preselected) ? message.preselected : [];
          renderFileList(currentFiles);
          fileSearch.value = '';
          fileModal.classList.add('show');
        }
        if (message.type === 'clear') {
          chat.textContent = '';
        }
      });

      const renderFileList = (files) => {
        fileList.textContent = '';
        const fragment = document.createDocumentFragment();
        files.forEach((file) => {
          const row = document.createElement('label');
          row.className = 'file-item';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.value = file;
          checkbox.checked = preselectedFiles.includes(file);
          checkbox.addEventListener('change', updateCount);
          const text = document.createElement('span');
          text.textContent = file;
          row.appendChild(checkbox);
          row.appendChild(text);
          fragment.appendChild(row);
        });
        fileList.appendChild(fragment);
        updateCount();
      };

      const updateCount = () => {
        const selected = fileList.querySelectorAll('input[type="checkbox"]:checked').length;
        fileCount.textContent = selected + ' selected';
      };

      fileSearch.addEventListener('input', () => {
        const query = fileSearch.value.trim().toLowerCase();
        const filtered = currentFiles.filter((file) => file.toLowerCase().includes(query));
        renderFileList(filtered);
      });

      fileApply.addEventListener('click', () => {
        const selected = Array.from(fileList.querySelectorAll('input[type="checkbox"]:checked'))
          .map((input) => input.value);
        fileModal.classList.remove('show');
        vscode.postMessage({ type: 'fileSelectionResult', files: selected });
      });

      fileCancel.addEventListener('click', () => {
        fileModal.classList.remove('show');
        vscode.postMessage({ type: 'fileSelectionResult', files: [] });
      });
    </script>
  </body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
