/* WaitEarn — AI generation detector for many AI chat platforms:
   ChatGPT, Claude, Gemini, DeepSeek, Grok (app + x.com), Copilot,
   Mistral Le Chat, Perplexity, Kimi, Qwen, Meta AI, Character.AI.

   Primary signal: the platform's own "Stop" button (it usually only exists
   while generating). Fallback: the last assistant message's text growing.
   PRIVACY: only text LENGTH is compared — content is never stored or sent. */
(() => {
  "use strict";
  if (window.__waitearnMainLoaded) return;
  window.__waitearnMainLoaded = true;

  const host = location.hostname.replace(/^www\./, "");
  const on = (site) => host === site || host.endsWith("." + site);

  /* Per-platform adapters. Stop-selectors and message containers differ per
     platform and change over time — for sketchy ones we lean on the
     universal text-growth fallback below. */
  let cfg = null;

  if (on("chatgpt.com") || on("chat.openai.com")) {
    cfg = {
      stop: ['button[data-testid="stop-button"]', 'button[aria-label="Stop"]'],
      assistant: ['[data-message-author-role="assistant"]']
    };
  } else if (on("claude.ai")) {
    cfg = {
      stop: ['button[data-testid="stop-response"]', 'button[aria-label*="Stop" i]'],
      assistant: ['[data-testid="assistant-message"]', '.font-claude-message']
    };
  } else if (on("gemini.google.com")) {
    cfg = {
      stop: ['button[aria-label="Stop"]', 'button[aria-label*="Stop" i]', '.stop-icon'],
      assistant: ['.model-response-text', 'message-content']
    };
  } else if (on("deepseek.com")) {
    cfg = {
      stop: ['div[role="button"][aria-label*="stop" i]', 'button[aria-label*="stop" i]'],
      assistant: ['.ds-markdown', 'div[class*="markdown"]']
    };
  } else if (on("grok.com") || on("x.com")) {
    cfg = {
      stop: ['button[aria-label*="Stop" i]', 'button[data-testid*="stop" i]'],
      assistant: ['[data-testid^="conversation-turn"]', 'article', 'div[class*="markdown"]']
    };
  } else if (on("copilot.microsoft.com")) {
    cfg = {
      stop: ['button[aria-label="Stop responding"]', 'button[aria-label*="Stop" i]'],
      assistant: ['[data-content="ai-message"]', '.entity-message-turn-content']
    };
  } else if (on("mistral.ai")) {
    cfg = {
      stop: ['button[aria-label*="Stop" i]'],
      assistant: ['div[class*="markdown"]', '[data-testid*="assistant" i]']
    };
  } else if (on("perplexity.ai")) {
    cfg = {
      stop: ['button[aria-label*="Stop" i]', 'button[data-testid*="stop" i]'],
      assistant: ['[data-stream-item]', '.prose', 'div[class*="markdown"]']
    };
  } else if (on("kimi.com") || on("kimi.moonshot.cn") || on("moonshot.cn")) {
    cfg = {
      stop: ['button[aria-label*="stop" i]', 'div[role="button"][aria-label*="stop" i]'],
      assistant: ['.markdown-body', 'div[class*="markdown"]']
    };
  } else if (on("qwen.ai") || on("tongyi.aliyun.com")) {
    cfg = {
      stop: ['button[aria-label*="Stop" i]', 'div[class*="stop" i]'],
      assistant: ['.tongyi-markdown', 'div[class*="markdown"]']
    };
  } else if (on("meta.ai")) {
    cfg = {
      stop: ['button[aria-label*="Stop" i]'],
      assistant: ['div[role="article"]', 'div[class*="message" i]']
    };
  } else if (on("character.ai")) {
    cfg = {
      stop: ['button[aria-label*="Stop" i]'],
      assistant: ['[class*="markdown"]', '[id*="message" i]']
    };
  } else {
    // Generic adapter — best-effort detection on newly matched hosts.
    cfg = {
      stop: [
        'button[aria-label*="stop" i]',
        '[role="button"][aria-label*="stop" i]',
        'button[data-testid*="stop" i]'
      ],
      assistant: [
        '[data-message-author-role="assistant"]',
        '[data-testid*="assistant" i]',
        'div[class*="markdown"]'
      ]
    };
  }

  let generating = false;
  let lastLen = -1;
  let growing = false;
  let lastGrowAt = 0;
  const bootTime = Date.now();

  function stopVisible() {
    return cfg.stop.some((sel) => {
      try { return !!document.querySelector(sel); } catch (e) { return false; }
    });
  }

  function lastAssistant() {
    let found = null;
    for (const sel of cfg.assistant) {
      try {
        const all = document.querySelectorAll(sel);
        if (all.length) found = all[all.length - 1];
      } catch (e) { /* ignore */ }
    }
    return found;
  }

  setInterval(() => {
    let active = stopVisible();

    if (!active) {
      // grace period after page load: plain text initialisation should not
      // look like a live generation
      if (Date.now() - bootTime > 4000) {
        const node = lastAssistant();
        if (node) {
          const len = (node.textContent || "").length;
          if (lastLen >= 0) {
            if (len > lastLen + 6) {
              growing = true;
              lastGrowAt = Date.now();
            } else if (growing && Date.now() - lastGrowAt > 1500) {
              growing = false;
            }
          }
          lastLen = len;
        }
        active = growing;
      }
    } else {
      growing = false;
      lastLen = -1;
    }

    if (active !== generating) {
      generating = active;
      if (generating) {
        if (window.WaitEarnCard) window.WaitEarnCard.show();
      } else {
        if (window.WaitEarnCard) window.WaitEarnCard.hide("end");
      }
    }
  }, 600);
})();
