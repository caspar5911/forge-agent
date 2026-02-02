import * as vscode from 'vscode';

export function getForgeHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  const csp =
    "default-src 'none'; " +
    `img-src ${webview.cspSource} data:; ` +
    `style-src ${webview.cspSource} 'unsafe-inline'; ` +
    `script-src 'nonce-${nonce}';`;

  return String.raw`<!DOCTYPE html>
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

      .steps {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 10px;
      }

      .step {
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 11px;
        border: 1px solid var(--border);
        color: var(--muted);
        background: rgba(255, 255, 255, 0.04);
      }

      .step.active {
        color: #0a0f15;
        background: linear-gradient(135deg, #4db8ff, #3dd6a1);
        border-color: transparent;
      }

      .chat {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        border-radius: 14px;
        background: rgba(10, 14, 20, 0.35);
      }

      .empty {
        border: 1px dashed rgba(148, 163, 184, 0.3);
        padding: 16px;
        border-radius: 12px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.5;
        background: rgba(13, 18, 26, 0.7);
      }

      .message {
        max-width: 82%;
        padding: 10px 12px;
        border-radius: 14px;
        font-size: 13px;
        line-height: 1.4;
        border: 1px solid var(--border);
        white-space: pre-wrap;
        position: relative;
      }

      .copy-btn {
        position: absolute;
        top: 6px;
        right: 6px;
        background: rgba(255, 255, 255, 0.08);
        color: var(--muted);
        border: 1px solid rgba(148, 163, 184, 0.25);
        border-radius: 8px;
        padding: 2px 6px;
        font-size: 10px;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.2s ease;
      }

      .message:hover .copy-btn {
        opacity: 1;
      }

      .toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: rgba(15, 23, 42, 0.9);
        color: #d5dde7;
        border: 1px solid rgba(148, 163, 184, 0.2);
        padding: 8px 12px;
        border-radius: 10px;
        font-size: 12px;
        opacity: 0;
        pointer-events: none;
        transform: translateY(6px);
        transition: opacity 0.2s ease, transform 0.2s ease;
        z-index: 40;
      }

      .toast.show {
        opacity: 1;
        transform: translateY(0);
      }

      .message h1,
      .message h2,
      .message h3 {
        margin: 0.6em 0 0.3em;
        line-height: 1.2;
      }

      .message h1 {
        font-size: 18px;
      }

      .message h2 {
        font-size: 16px;
      }

      .message h3 {
        font-size: 14px;
      }

      .message ul,
      .message ol {
        margin: 0.4em 0 0.4em 1.2em;
        padding: 0;
      }

      .message li {
        margin: 0.2em 0;
      }

      .message blockquote {
        margin: 0.5em 0;
        padding: 0.4em 0.8em;
        border-left: 3px solid rgba(77, 184, 255, 0.5);
        background: rgba(13, 18, 26, 0.6);
        color: var(--muted);
        border-radius: 8px;
      }

      .message table {
        width: 100%;
        border-collapse: collapse;
        margin: 0.6em 0;
        font-size: 12px;
      }

      .message th,
      .message td {
        border: 1px solid rgba(148, 163, 184, 0.2);
        padding: 6px 8px;
        text-align: left;
      }

      .message th {
        background: rgba(77, 184, 255, 0.12);
        color: #d9efff;
        font-weight: 600;
      }

      .message tr:nth-child(even) td {
        background: rgba(255, 255, 255, 0.03);
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

      .message code {
        background: rgba(15, 23, 42, 0.6);
        padding: 2px 6px;
        border-radius: 6px;
        font-family: "Consolas", "Courier New", monospace;
        font-size: 12px;
        border: 1px solid rgba(148, 163, 184, 0.2);
      }

      .message pre {
        background: rgba(10, 15, 20, 0.85);
        border: 1px solid rgba(148, 163, 184, 0.2);
        padding: 10px 12px;
        border-radius: 10px;
        overflow: auto;
        margin: 0.6em 0;
        font-size: 12px;
      }

      .message pre code {
        background: transparent;
        border: none;
        padding: 0;
        font-size: 12px;
      }

      .message pre code .token.keyword {
        color: #7dd3fc;
      }

      .message pre code .token.string {
        color: #fbbf24;
      }

      .message pre code .token.number {
        color: #a5b4fc;
      }

      .message pre code .token.comment {
        color: #94a3b8;
        font-style: italic;
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

      .message.error {
        align-self: center;
        background: rgba(248, 81, 73, 0.15);
        color: #ffd4d1;
        border-color: rgba(248, 81, 73, 0.4);
      }

      .message.streaming {
        position: relative;
      }

      .message.streaming::after {
        content: "▍";
        display: inline-block;
        margin-left: 2px;
        color: #9fb0c2;
        animation: blink 1s steps(2, start) infinite;
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

      .primary.running {
        background: linear-gradient(135deg, #ffb84d, #ff7a59);
        color: #2b1103;
        box-shadow: 0 10px 24px rgba(255, 122, 89, 0.25);
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

      @keyframes blink {
        to {
          opacity: 0;
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
        <div class="steps" id="steps">
          <div class="step active" data-step="ready">Ready</div>
          <div class="step" data-step="select">Select</div>
          <div class="step" data-step="update">Update</div>
          <div class="step" data-step="apply">Apply</div>
          <div class="step" data-step="validate">Validate</div>
        </div>
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

    <div class="toast" id="toast">Copied</div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const prompt = document.getElementById('prompt');
      const run = document.getElementById('run');
      const clear = document.getElementById('clear');
      const status = document.getElementById('status');
      const chat = document.getElementById('chat');
      const steps = document.getElementById('steps');
      const activeFileName = document.getElementById('active-file-name');
      const fileModal = document.getElementById('file-modal');
      const fileList = document.getElementById('file-list');
      const fileSearch = document.getElementById('file-search');
      const fileApply = document.getElementById('file-apply');
      const fileCancel = document.getElementById('file-cancel');
      const fileCount = document.getElementById('file-count');
      const toast = document.getElementById('toast');
      let chatHistory = [];
      let currentFiles = [];
      let preselectedFiles = [];
      let emptyState = null;
      let streamMessage = null;
      let streamBuffer = '';

      const ensureEmptyState = () => {
        if (!emptyState) {
          emptyState = document.createElement('div');
          emptyState.className = 'empty';
          emptyState.innerHTML =
            '<strong>Try:</strong><br>' +
            '• Add comments to App.tsx<br>' +
            '• Remove unused imports in Timesheet.tsx<br>' +
            '• Fix validation errors for the project<br><br>' +
            '<strong>Shortcuts:</strong> Enter to send, Shift+Enter for a new line, Esc to stop.';
        }
        if (chat.children.length === 0) {
          chat.appendChild(emptyState);
        }
      };

      const updateEmptyState = () => {
        if (chat.children.length === 0) {
          ensureEmptyState();
          return;
        }
        if (emptyState && chat.contains(emptyState) && chat.children.length > 1) {
          emptyState.remove();
        }
      };

      const classifyAssistantMessage = (text) => {
        const lower = text.toLowerCase();
        if (lower.includes('error') || lower.includes('failed')) {
          return 'error';
        }
        if (lower.includes('cancelled') || lower.includes('no changes')) {
          return 'system';
        }
        return 'assistant';
      };

      const setStep = (key) => {
        if (!steps) return;
        const items = steps.querySelectorAll('.step');
        items.forEach((item) => {
          if (item.dataset.step === key) {
            item.classList.add('active');
          } else {
            item.classList.remove('active');
          }
        });
      };

      const escapeHtml = (value) =>
        value
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');

      const formatInline = (value) => {
        const tick = String.fromCharCode(96);
        const codeRegex = new RegExp(tick + '([^' + tick + ']+)' + tick, 'g');
        const codeProcessed = value.replace(codeRegex, '<code>$1</code>');
        const parts = codeProcessed.split(/(<code>.*?<\/code>)/g);
        return parts
          .map((part) => {
            if (part.startsWith('<code>')) {
              return part;
            }
            return part
              .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
              .replace(/\*([^*]+)\*/g, '<em>$1</em>');
          })
          .join('');
      };

      const highlightCode = (value) => {
        const escaped = escapeHtml(value);
        const withComments = escaped
          .replace(/(\/\/[^\n]*)/g, '<span class="token comment">$1</span>')
          .replace(/\/\*[\s\S]*?\*\//g, (match) => '<span class="token comment">' + match + '</span>');
        const withStrings = withComments
          .replace(/(&quot;[^&]*?&quot;)/g, '<span class="token string">$1</span>')
          .replace(/(&#39;[^&]*?&#39;)/g, '<span class="token string">$1</span>')
          .replace(new RegExp(String.fromCharCode(96) + '[^' + String.fromCharCode(96) + ']*' + String.fromCharCode(96), 'g'), '<span class="token string">$&</span>');
        const withNumbers = withStrings.replace(/\b(\d+(\.\d+)?)\b/g, '<span class="token number">$1</span>');
        const keywords = [
          'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'switch', 'case',
          'break', 'continue', 'class', 'new', 'try', 'catch', 'throw', 'import', 'export', 'from',
          'async', 'await', 'extends', 'implements', 'interface', 'type', 'enum'
        ];
        const keywordRegex = new RegExp('\\b(' + keywords.join('|') + ')\\b', 'g');
        const parts = withNumbers.split(/(<[^>]+>)/g);
        return parts
          .map((part) => {
            if (part.startsWith('<')) {
              return part;
            }
            return part.replace(keywordRegex, '<span class="token keyword">$1</span>');
          })
          .join('');
      };

      const renderMarkdown = (value) => {
        const escaped = escapeHtml(value);
        const lines = escaped.split(/\r?\n/);
        let html = '';
        let inUl = false;
        let inOl = false;
        let inTable = false;
        let tableHeaderDone = false;
        let tableBuffer = [];
        let inCodeBlock = false;
        let codeBuffer = [];
        const tick = String.fromCharCode(96);
        const fence = tick + tick + tick;

        const closeLists = () => {
          if (inUl) {
            html += '</ul>';
            inUl = false;
          }
          if (inOl) {
            html += '</ol>';
            inOl = false;
          }
        };

        const flushTable = () => {
          if (!inTable || tableBuffer.length === 0) {
            inTable = false;
            tableHeaderDone = false;
            tableBuffer = [];
            return;
          }
          html += '<table>';
          tableBuffer.forEach((row, idx) => {
            if (idx === 1 && row.every((cell) => /^-+$/.test(cell))) {
              tableHeaderDone = true;
              return;
            }
            if (idx === 0 && !tableHeaderDone) {
              html += '<thead><tr>' + row.map((cell) => '<th>' + formatInline(cell.trim()) + '</th>').join('') + '</tr></thead><tbody>';
              return;
            }
            html += '<tr>' + row.map((cell) => '<td>' + formatInline(cell.trim()) + '</td>').join('') + '</tr>';
          });
          if (!tableHeaderDone && tableBuffer.length > 0) {
            html = html.replace('<tbody>', '<tbody>');
          }
          if (!html.endsWith('</tbody>')) {
            html += '</tbody>';
          }
          html += '</table>';
          inTable = false;
          tableHeaderDone = false;
          tableBuffer = [];
        };

        lines.forEach((line) => {
          const trimmed = line.trim();
          if (trimmed.startsWith(fence)) {
            if (!inCodeBlock) {
              inCodeBlock = true;
              codeBuffer = [];
            } else {
              html += '<pre><code>' + highlightCode(codeBuffer.join('\n')) + '</code></pre>';
              inCodeBlock = false;
              codeBuffer = [];
            }
            return;
          }

          if (inCodeBlock) {
            codeBuffer.push(line);
            return;
          }

          const headingMatch = /^(#{1,3})\s+(.+)$/.exec(trimmed);
          const ulMatch = /^[-*]\s+(.+)$/.exec(trimmed);
          const olMatch = /^\d+\.\s+(.+)$/.exec(trimmed);
          const isTableLine = /^\|.*\|$/.test(trimmed);
          const quoteMatch = /^>\s?(.*)$/.exec(trimmed);

          if (isTableLine) {
            closeLists();
            inTable = true;
            tableBuffer.push(trimmed.split('|').slice(1, -1));
            return;
          }

          if (inTable) {
            flushTable();
          }

          if (headingMatch) {
            closeLists();
            const level = headingMatch[1].length;
            html += '<h' + level + '>' + formatInline(headingMatch[2]) + '</h' + level + '>';
            return;
          }

          if (quoteMatch) {
            closeLists();
            html += '<blockquote>' + formatInline(quoteMatch[1] || '') + '</blockquote>';
            return;
          }

          if (ulMatch) {
            if (inOl) {
              html += '</ol>';
              inOl = false;
            }
            if (!inUl) {
              html += '<ul>';
              inUl = true;
            }
            html += '<li>' + formatInline(ulMatch[1]) + '</li>';
            return;
          }

          if (olMatch) {
            if (inUl) {
              html += '</ul>';
              inUl = false;
            }
            if (!inOl) {
              html += '<ol>';
              inOl = true;
            }
            html += '<li>' + formatInline(olMatch[1]) + '</li>';
            return;
          }

          if (trimmed.length === 0) {
            closeLists();
            if (inTable) {
              flushTable();
            }
            html += '<br>';
            return;
          }

          closeLists();
          html += '<div>' + formatInline(line) + '</div>';
        });

        closeLists();
        if (inTable) {
          flushTable();
        }
        if (inCodeBlock && codeBuffer.length > 0) {
          html += '<pre><code>' + highlightCode(codeBuffer.join('\n')) + '</code></pre>';
        }
        return html;
      };

      const showToast = (text) => {
        if (!toast) return;
        toast.textContent = text;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 900);
      };

      const copyText = async (text) => {
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          showToast('Copied');
          return;
        } catch {
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.focus();
          textarea.select();
          try {
            document.execCommand('copy');
            showToast('Copied');
          } catch {
            showToast('Copy failed');
          }
          document.body.removeChild(textarea);
        }
      };

      const attachCopyButton = (element, getText) => {
        const button = document.createElement('button');
        button.className = 'copy-btn';
        button.type = 'button';
        button.textContent = 'Copy';
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const text = getText();
          void copyText(text);
        });
        element.appendChild(button);
      };

      const addMessage = (role, text) => {
        if (!text) return;
        if (streamMessage) {
          streamMessage.classList.remove('streaming');
          streamMessage = null;
          streamBuffer = '';
        }
        const message = document.createElement('div');
        const resolvedRole = role === 'assistant' ? classifyAssistantMessage(text) : role;
        message.className = 'message ' + resolvedRole;
        if (role === 'user') {
          message.textContent = text;
        } else {
          message.innerHTML = renderMarkdown(text);
        }
        attachCopyButton(message, () => text);
        chat.appendChild(message);
        chat.scrollTop = chat.scrollHeight;
        updateEmptyState();
        if (role === 'user' || role === 'assistant' || role === 'system') {
          chatHistory.push({ role, content: text });
        }
      };

      const addDiff = (lines) => {
        if (!lines || !lines.length) return;
        if (streamMessage) {
          streamMessage.classList.remove('streaming');
          streamMessage = null;
          streamBuffer = '';
        }
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
        attachCopyButton(message, () => lines.join('\n'));
        chat.appendChild(message);
        chat.scrollTop = chat.scrollHeight;
        updateEmptyState();
      };

      run.addEventListener('click', () => {
        const text = prompt.value.trim();
        if (run.dataset.mode === 'stop') {
          status.textContent = 'Stopping...';
          run.textContent = 'Send';
          run.dataset.mode = 'send';
          run.classList.remove('running');
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
        run.classList.add('running');
        setStep('update');
        addMessage('user', text);
        prompt.value = '';
        vscode.postMessage({ type: 'run', text, history: chatHistory });
      });

      prompt.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          run.click();
        }
      });

      window.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && run.dataset.mode === 'stop') {
          event.preventDefault();
          run.click();
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
          event.preventDefault();
          clear.click();
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === '/') {
          event.preventDefault();
          prompt.focus();
        }
      });

      clear.addEventListener('click', () => {
        prompt.value = '';
        status.textContent = 'Idle';
        chat.textContent = '';
        run.textContent = 'Send';
        run.dataset.mode = 'send';
        run.classList.remove('running');
        setStep('ready');
        ensureEmptyState();
        vscode.postMessage({ type: 'clear' });
      });

      window.addEventListener('message', (event) => {
        const message = event.data;
        if (message.type === 'status') {
          status.textContent = message.text;
          const lower = message.text.toLowerCase();
          if (lower.includes('select')) {
            setStep('select');
          } else if (lower.includes('requesting') || lower.includes('llm') || lower.includes('update')) {
            setStep('update');
          } else if (lower.includes('apply')) {
            setStep('apply');
          } else if (lower.includes('validation')) {
            setStep('validate');
          } else if (lower.includes('done') || lower.includes('idle') || lower.includes('stopped')) {
            setStep('ready');
          }
          if (lower.includes('stopped') || lower.includes('done')) {
            run.textContent = 'Send';
            run.dataset.mode = 'send';
            run.classList.remove('running');
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
        if (message.type === 'streamStart') {
          if (streamMessage) {
            streamMessage.remove();
          }
          streamMessage = document.createElement('div');
          const role = message.role || 'assistant';
          streamMessage.className = 'message ' + role + ' streaming';
          streamMessage.textContent = '';
          streamBuffer = '';
          chat.appendChild(streamMessage);
          chat.scrollTop = chat.scrollHeight;
          updateEmptyState();
        }
        if (message.type === 'stream') {
          if (!streamMessage) {
            streamMessage = document.createElement('div');
            streamMessage.className = 'message assistant streaming';
            chat.appendChild(streamMessage);
          }
          streamBuffer += message.text || '';
          streamMessage.textContent = streamBuffer;
          chat.scrollTop = chat.scrollHeight;
          updateEmptyState();
        }
        if (message.type === 'streamEnd') {
          if (streamMessage) {
            streamMessage.classList.remove('streaming');
            streamMessage.innerHTML = renderMarkdown(streamBuffer);
            attachCopyButton(streamMessage, () => streamBuffer);
            streamMessage = null;
            streamBuffer = '';
          }
        }
        if (message.type === 'fileSelection') {
          currentFiles = Array.isArray(message.files) ? message.files : [];
          preselectedFiles = Array.isArray(message.preselected) ? message.preselected : [];
          renderFileList(currentFiles);
          fileSearch.value = '';
          fileModal.classList.add('show');
          setStep('select');
        }
        if (message.type === 'clear') {
          chat.textContent = '';
          streamMessage = null;
          ensureEmptyState();
          chatHistory = [];
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
        setStep('update');
      });

      fileCancel.addEventListener('click', () => {
        fileModal.classList.remove('show');
        vscode.postMessage({ type: 'fileSelectionResult', files: [] });
        setStep('ready');
      });

      ensureEmptyState();
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
