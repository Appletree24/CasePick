// Keep the browser bundle self-contained; all colors follow the DSH theme.
export const casepickStyles = `
.casepick-page {
    box-sizing: border-box;
    container-type: inline-size;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: auto;
    color: var(--dsw-alias-label-primary);
    background: var(--dsw-alias-bg-base);
    font-size: 14px;
    line-height: 22px;
}
.casepick-page-inner {
    box-sizing: border-box;
    max-width: 760px;
    margin: 0 auto;
    padding: calc(32px + var(--dsh-frame-top-clearance, 0px)) 32px 24px;
}
.casepick-page-heading {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 28px;
}
.casepick-page-mark {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 40px;
    height: 40px;
    border-radius: var(--dsw-radius-lg);
    color: var(--dsw-alias-state-business-primary);
    background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
}
.casepick-page h1 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    line-height: 28px;
}
.casepick-page-intro {
    margin: 2px 0 0;
    color: var(--dsw-alias-label-tertiary);
    font-size: 13px;
    line-height: 20px;
}
.casepick-settings-form, .casepick-stack {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 16px;
}
.casepick-card {
    padding: 20px 24px 4px;
    border: 0.5px solid var(--dsw-alias-border-l2);
    border-radius: var(--dsw-radius-panel);
    background: var(--dsw-alias-bg-layer-1);
}
.casepick-card-heading {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-bottom: 16px;
}
.casepick-card h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    line-height: 22px;
}
.casepick-hint {
    display: block;
    margin: 0;
    color: var(--dsw-alias-label-tertiary);
    font-size: 12px;
    line-height: 18px;
    overflow-wrap: anywhere;
}
.casepick-page code {
    font-family: var(--dsw-font-markdown-code-font-family, monospace);
    font-size: 0.95em;
}
.casepick-field {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 240px;
    align-items: center;
    gap: 24px;
    padding: 16px 0;
    border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.casepick-field-copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 4px;
}
.casepick-field-heading {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-weight: 500;
}
.casepick-field-control { min-width: 0; }
.casepick-field-toggle .casepick-field-control {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
}
.casepick-field-invalid .casepick-hint { color: var(--dsw-alias-state-error-primary); }
.casepick-input, .casepick-select-wrap {
    box-sizing: border-box;
    width: 100%;
}
.casepick-input:has(input:disabled) { opacity: 0.5; }
.casepick-field-invalid .casepick-input { border-color: var(--dsw-alias-state-error-primary); }
.casepick-select-wrap { position: relative; }
.casepick-select {
    box-sizing: border-box;
    appearance: none;
    width: 100%;
    min-height: 34px;
    padding: 5px 32px 5px 10px;
    border: 0.5px solid var(--dsw-alias-border-l4);
    border-radius: var(--dsw-radius-md);
    color: var(--dsw-alias-label-primary);
    background: var(--dsw-alias-bg-layer-1);
    font: inherit;
    cursor: pointer;
}
.casepick-select-icon {
    position: absolute;
    right: 10px;
    top: 50%;
    transform: translateY(-50%);
    pointer-events: none;
    color: var(--dsw-alias-label-tertiary);
}
.casepick-select:disabled { cursor: default; opacity: 0.5; }
.casepick-select[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.casepick-wizard {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding-bottom: 20px;
}
.casepick-wizard .casepick-card-heading { padding-bottom: 0; }
.casepick-wizard-button {
    align-self: flex-start;
    max-width: 100%;
    height: auto;
    min-height: 36px;
    padding-block: 7px;
    text-align: left;
    white-space: normal;
    overflow-wrap: anywhere;
}
.casepick-savebar {
    position: sticky;
    bottom: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 0;
    border-top: 0.5px solid var(--dsw-alias-border-l2);
    background: var(--dsw-alias-bg-base);
}
.casepick-actions { display: flex; align-items: center; gap: 8px; flex: none; }
.casepick-action { min-width: 72px; }
.casepick-status {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    color: var(--dsw-alias-label-secondary);
    font-size: 13px;
    line-height: 20px;
    overflow-wrap: anywhere;
}
.casepick-status-text { min-width: 0; white-space: pre-wrap; }
.casepick-success { color: var(--dsw-alias-state-success-primary); }
.casepick-failed { color: var(--dsw-alias-state-error-primary); }
.casepick-muted { color: var(--dsw-alias-label-tertiary); }
.casepick-notice {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 12px 14px;
    border-radius: var(--dsw-radius-md);
    background: color-mix(in srgb, var(--casepick-notice-color) 10%, transparent);
    color: var(--dsw-alias-label-secondary);
    font-size: 13px;
    line-height: 21px;
}
.casepick-notice[data-level="info"] { --casepick-notice-color: var(--dsw-alias-state-business-primary); }
.casepick-notice[data-level="warning"] {
    --casepick-notice-color: var(--dsw-alias-state-warn-primary);
    background: color-mix(in srgb, var(--casepick-notice-color) 12%, transparent);
}
.casepick-notice[data-level="error"] { --casepick-notice-color: var(--dsw-alias-state-error-primary); }
.casepick-notice-icon { flex: none; margin-top: 2px; color: var(--casepick-notice-color); }
.casepick-notice-text { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.casepick-modal[role="dialog"] {
    width: min(560px, 100%);
    max-height: 100%;
    color: var(--dsw-alias-label-primary);
    font-size: 14px;
    line-height: 22px;
}
.casepick-modal-content { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.casepick-dialog-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    line-height: 24px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.casepick-detail {
    max-height: 260px;
    overflow: auto;
    overscroll-behavior: contain;
    padding: 14px 16px;
    border-radius: var(--dsw-radius-md);
    background: var(--dsw-specific-sidebar-fill);
    color: var(--dsw-alias-label-secondary);
    font-size: 13px;
    line-height: 22px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.casepick-message {
    margin: 0;
    color: var(--dsw-alias-label-secondary);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}
.casepick-options { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.casepick-option {
    display: flex;
    align-items: center;
    gap: 12px;
    box-sizing: border-box;
    width: 100%;
    min-height: 42px;
    padding: 10px 12px;
    border: 0;
    border-radius: var(--dsw-radius-md);
    color: var(--dsw-alias-label-primary);
    background: transparent;
    font: inherit;
    text-align: left;
    cursor: pointer;
}
.casepick-option-text { flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.casepick-option-icon { flex: none; color: var(--dsw-alias-label-tertiary); }
.casepick-option:hover:not(:disabled), .casepick-option:focus-visible:not(:disabled) {
    background: var(--dsw-alias-interactive-bg-hover);
}
.casepick-option:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.casepick-option:disabled { opacity: 0.4; cursor: not-allowed; }
.casepick-editor {
    box-sizing: border-box;
    width: 100%;
    min-width: 0;
    min-height: 160px;
    max-height: 400px;
    resize: vertical;
    padding: 12px 14px;
    border: 0.5px solid var(--dsw-alias-border-l4);
    border-radius: var(--dsw-radius-md);
    color: var(--dsw-alias-label-primary);
    background: var(--dsw-alias-bg-layer-1);
    font: inherit;
    line-height: 24px;
}
.casepick-editor:focus, .casepick-select:focus { border-color: var(--dsw-alias-state-business-primary); }
.casepick-editor:disabled { opacity: 0.5; }
.casepick-shortcuts {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: -8px;
    color: var(--dsw-alias-label-tertiary);
    font-size: 12px;
    line-height: 18px;
}
.casepick-shortcuts > span { display: inline-flex; align-items: center; gap: 4px; }
.casepick-notices { display: flex; flex-direction: column; gap: 8px; max-height: 240px; overflow: auto; }
.casepick-modal-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; width: 100%; }
.casepick-modal-actions .casepick-cancel { margin-right: auto; }
.casepick-option:focus-visible, .casepick-editor:focus-visible, .casepick-select:focus-visible,
.casepick-detail:focus-visible, .casepick-notices:focus-visible,
.casepick-action:focus-visible, .casepick-wizard-button:focus-visible {
    outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
    outline-offset: 2px;
}
@container (max-width: 600px) {
    .casepick-page-inner { padding-inline: 20px; }
    .casepick-card { padding-inline: 18px; }
    .casepick-field { grid-template-columns: minmax(0, 1fr); gap: 10px; }
    .casepick-field-toggle { grid-template-columns: minmax(0, 1fr) auto; gap: 16px; }
}
@container (max-width: 400px) {
    .casepick-page-inner { padding-inline: 16px; }
    .casepick-savebar { flex-wrap: wrap; gap: 12px; }
    .casepick-savebar .casepick-actions { margin-left: auto; }
}
`;

export function injectStyles(): () => void {
    if (document.querySelector('style[data-plugin-css="casepick"]')) return () => {};
    const style = document.createElement("style");
    style.dataset.plugin = "casepick";
    style.dataset.pluginCss = "casepick";
    style.textContent = casepickStyles;
    document.head.appendChild(style);
    return () => style.remove();
}
