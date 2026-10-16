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
.casepick-workflow-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }
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
.casepick-workspace {
    box-sizing: border-box;
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    color: var(--dsw-alias-label-primary);
    background: var(--dsw-alias-bg-base);
    font-size: 13px;
    line-height: 21px;
}
.casepick-workspace *, .casepick-workspace *::before, .casepick-workspace *::after { box-sizing: border-box; }
.casepick-workspace-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: calc(20px + var(--dsh-frame-top-clearance, 0px)) 24px 16px;
    flex: none;
}
.casepick-brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.casepick-brand h1 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 600; letter-spacing: -0.3px; }
.casepick-brand p { margin: 2px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.casepick-workspace-session { max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.casepick-tabs { display: flex; gap: 24px; padding: 0 24px; border-bottom: 1px solid var(--dsw-alias-border-l2); flex: none; }
.casepick-tabs button {
    position: relative; padding: 10px 0 12px; border: 0; background: none; color: var(--dsw-alias-label-tertiary);
    font: inherit; white-space: nowrap; cursor: pointer;
}
.casepick-tabs button[aria-current] { color: var(--dsw-alias-label-primary); font-weight: 600; }
.casepick-tabs button[aria-current]::after { content: ""; position: absolute; bottom: -1px; left: 0; right: 0; height: 2px; background: var(--dsw-alias-state-business-primary); border-radius: 2px; }
.casepick-workspace-grid { display: grid; grid-template-columns: minmax(0, 1fr); flex: 1; min-height: 0; }
.casepick-workspace-grid.casepick-has-workflow { grid-template-columns: minmax(0, 1fr) minmax(320px, 32%); }
.casepick-workspace-content { min-width: 0; min-height: 0; overflow: hidden; }
.casepick-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 64px; padding: 16px 20px; flex: none; }
.casepick-section-heading > div { min-width: 0; }
.casepick-section-heading h2 { margin: 0; font-size: 14px; font-weight: 600; line-height: 22px; overflow-wrap: anywhere; }
.casepick-eyebrow { display: block; color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 18px; letter-spacing: 0.4px; margin-bottom: 3px; }
.casepick-count { color: var(--dsw-alias-label-tertiary); font-size: 12px; font-weight: 400; margin-left: 4px; }
.casepick-session-grid { display: grid; grid-template-columns: 240px minmax(0, 1fr); height: 100%; min-height: 0; }
.casepick-session-browser { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.casepick-session-browser .casepick-section-heading { padding-inline: 16px; }
.casepick-session-search { padding: 0 12px; }
.casepick-browser-hint { margin: 8px 16px 12px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.casepick-session-list { flex: 1; min-height: 0; overflow: auto; padding: 0 8px 16px; }
.casepick-list-item {
    display: flex; flex-direction: column; gap: 4px; width: 100%; min-width: 0; padding: 12px;
    border: 1px solid transparent; border-radius: var(--dsw-radius-md); color: inherit;
    background: transparent; text-align: left; font: inherit; cursor: pointer;
}
.casepick-list-item strong { font-size: 13px; line-height: 20px; font-weight: 500; overflow-wrap: anywhere; }
.casepick-list-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.casepick-list-item[aria-pressed="true"] { background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 24%, transparent); }
.casepick-path { display: block; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.casepick-timeline { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.casepick-timeline-toolbar { display: flex; flex-direction: column; gap: 6px; padding: 0 20px 16px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.casepick-timeline-entries { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 16px 20px; }
.casepick-entry { border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg); margin-bottom: 14px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.casepick-entry[data-selected] { border-color: var(--dsw-alias-state-business-primary); }
.casepick-entry > header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.casepick-entry-id { color: var(--dsw-alias-label-tertiary); font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 11px; }
.casepick-role { font-size: 12px; font-weight: 500; }
.casepick-entry-content { padding: 14px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.75; tab-size: 4; }
.casepick-cutoff { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.casepick-cutoff input { accent-color: var(--dsw-alias-state-business-primary); }
.casepick-tool { margin: 10px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); }
.casepick-tool summary { cursor: pointer; padding: 8px 10px; overflow-wrap: anywhere; }
.casepick-tool summary .casepick-hint { display: inline; }
.casepick-tool pre { margin: 0; padding: 12px; border-top: 1px solid var(--dsw-alias-border-l2); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; font-family: var(--dsw-font-markdown-code-font-family, monospace); }
.casepick-timeline-footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 14px 20px; border-top: 1px solid var(--dsw-alias-border-l2); flex: none; }
.casepick-workflow { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-left: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.casepick-workflow > .casepick-section-heading { border-bottom: 1px solid var(--dsw-alias-border-l2); }
.casepick-workflow-body { flex: 1; min-height: 0; overflow: auto; padding: 20px; overscroll-behavior: contain; }
.casepick-workflow-body:empty { display: none; }
.casepick-workflow .casepick-detail { max-height: none; flex-shrink: 0; font-family: var(--dsw-font-markdown-code-font-family, monospace); font-size: 12px; }
.casepick-workflow .casepick-notices { max-height: none; overflow: visible; }
.casepick-workflow .casepick-options { gap: 6px; }
.casepick-workflow .casepick-option { border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); }
.casepick-workflow-actions { padding: 14px 20px; border-top: 1px solid var(--dsw-alias-border-l2); flex: none; background: var(--dsw-alias-bg-layer-1); }
.casepick-workflow-actions > :first-child { margin-right: auto; }
.casepick-empty { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 8px; padding: 32px 24px; color: var(--dsw-alias-label-tertiary); }
.casepick-empty h3 { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 14px; font-weight: 500; }
.casepick-empty p { margin: 0; line-height: 22px; overflow-wrap: anywhere; }
.casepick-workflow > .casepick-empty { flex: 1; justify-content: flex-start; padding-top: 32px; }
.casepick-loading { display: flex; align-items: center; gap: 8px; padding: 20px; color: var(--dsw-alias-label-tertiary); }
.casepick-library { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.casepick-library-search { padding: 0 20px 16px; border-bottom: 1px solid var(--dsw-alias-border-l2); }
.casepick-library-grid { display: grid; grid-template-columns: minmax(180px, 36%) minmax(0, 1fr); flex: 1; min-height: 0; }
.casepick-library-list { min-height: 0; overflow: auto; padding: 12px; border-right: 1px solid var(--dsw-alias-border-l2); }
.casepick-library-detail { display: flex; flex-direction: column; align-items: flex-start; gap: 16px; padding: 24px; min-width: 0; overflow: auto; }
.casepick-library-detail h3 { margin: 0; font-size: 17px; line-height: 26px; font-weight: 600; overflow-wrap: anywhere; }
.casepick-metadata { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px 20px; width: 100%; margin: 0; font-size: 12px; }
.casepick-metadata dt { color: var(--dsw-alias-label-tertiary); }
.casepick-metadata dd { margin: 0; overflow-wrap: anywhere; }
.casepick-asset-content { width: 100%; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; line-height: 20px; font-family: var(--dsw-font-markdown-code-font-family, monospace); }
.casepick-asset-document { width: 100%; min-width: 0; }
.casepick-asset-document > summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 12px; margin-bottom: 12px; }
.casepick-workspace .casepick-page { container-type: inline-size; }
.casepick-workspace .casepick-page-inner { padding-top: 24px; padding-inline: 24px; }
.casepick-workspace .casepick-page-heading .casepick-page-mark { display: none; }
.casepick-tabs button:focus-visible, .casepick-list-item:focus-visible, .casepick-tool summary:focus-visible, .casepick-cutoff:has(input:focus-visible) { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px; }
@container (max-width: 1150px) {
    .casepick-session-grid { grid-template-columns: 200px minmax(0, 1fr); }
    .casepick-workspace-grid.casepick-has-workflow { grid-template-columns: minmax(0, 1fr) 320px; }
    .casepick-timeline-entries { padding: 12px; }
    .casepick-timeline-toolbar { padding-inline: 12px; }
}
@container (max-width: 900px) {
    .casepick-workspace-grid { overflow: auto; }
    .casepick-workspace-grid.casepick-has-workflow { grid-template-columns: minmax(0, 1fr); overflow: auto; display: flex; flex-direction: column; }
    .casepick-workspace-content { min-height: 500px; flex: 1 0 65%; }
    .casepick-workflow { border-left: 0; border-top: 1px solid var(--dsw-alias-border-l2); min-height: 280px; max-height: none; flex: none; }
    .casepick-workflow-body { overflow: visible; }
    .casepick-workflow .casepick-detail { max-height: 420px; overflow: auto; }
    .casepick-workspace .casepick-page { height: auto; }
    .casepick-library { min-height: 500px; }
}
@container (max-width: 600px) {
    .casepick-workspace-header { padding-inline: 16px; gap: 12px; }
    .casepick-workspace-session { display: none; }
    .casepick-tabs { padding-inline: 16px; gap: 22px; overflow-x: auto; }
    .casepick-session-grid { display: flex; flex-direction: column; }
    .casepick-session-browser { flex: none; max-height: 260px; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); }
    .casepick-session-list { min-height: 80px; max-height: 140px; }
    .casepick-session-browser .casepick-section-heading { min-height: 48px; padding-block: 8px; }
    .casepick-browser-hint { margin-block: 4px; }
    .casepick-timeline { min-height: 360px; flex: 1; }
    .casepick-workspace-content { min-height: 650px; flex-basis: auto; flex-shrink: 0; }
    .casepick-library-grid { grid-template-columns: minmax(0, 1fr); overflow: auto; }
    .casepick-library-list { max-height: 220px; border-right: 0; border-bottom: 1px solid var(--dsw-alias-border-l2); flex: none; }
    .casepick-library-detail { min-height: 280px; overflow: visible; padding: 20px; }
    .casepick-section-heading { padding-inline: 16px; }
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
