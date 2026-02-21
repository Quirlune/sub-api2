// ==================================================
// Sub-API Processor - SillyTavern Extension
// ==================================================
// 多任务副API处理器：AI回复完成后并行调用多个独立的副API任务

(function () {
    const MODULE_NAME = 'sub_api_processor';
    const METADATA_KEY = 'sub_api_results';
    const RENDER_LIMIT = 7;
    const CONTEXT_MARKER_START = (taskId) => `\n<!-- sub-api:${taskId}:start -->`;
    const CONTEXT_MARKER_END = (taskId) => `<!-- sub-api:${taskId}:end -->`;

    // ===== Default Settings =====
    const defaultSettings = Object.freeze({
        enabled: true,
        apiKey: '',
        modelName: 'gemini-2.0-flash',
        tasks: [],
    });

    function createDefaultTask() {
        return {
            id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: '新任务',
            enabled: true,
            systemPrompt: '你是一个辅助分析助手。请根据以下对话内容进行分析。',
            userPrompt: '请分析以下内容：\n{{char1}}',
            inputRegexList: [],
            outputRegexList: [],
            finalRegexList: [],
            renderPosition: 'below', // 'above' | 'below'
            writeToContext: false,
        };
    }

    // ===== State =====
    let swipeFlag = false;

    // ===== Helper: Get Settings =====
    function getSettings() {
        const { extensionSettings } = SillyTavern.getContext();
        if (!extensionSettings[MODULE_NAME]) {
            extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
        }
        const s = extensionSettings[MODULE_NAME];
        for (const key of Object.keys(defaultSettings)) {
            if (!Object.hasOwn(s, key)) {
                s[key] = structuredClone(defaultSettings[key]);
            }
        }
        return s;
    }

    function saveSettings() {
        const { saveSettingsDebounced } = SillyTavern.getContext();
        saveSettingsDebounced();
    }

    // ===== Helper: Get/Save Chat Results =====
    function getChatResults() {
        const { chatMetadata } = SillyTavern.getContext();
        if (!chatMetadata[METADATA_KEY]) {
            chatMetadata[METADATA_KEY] = {};
        }
        return chatMetadata[METADATA_KEY];
    }

    async function saveChatMetadata() {
        const { saveMetadata } = SillyTavern.getContext();
        await saveMetadata();
    }

    // ===== Context Extraction =====
    function extractContextMap() {
        const { chat } = SillyTavern.getContext();
        const userMessages = [];
        const charMessages = [];

        for (let i = chat.length - 1; i >= 0; i--) {
            const msg = chat[i];
            if (!msg || msg.is_system) continue;
            // 获取纯净消息（去掉已注入的sub-api标记内容）
            const cleanMes = stripContextMarkers(msg.mes || '');
            if (msg.is_user) {
                userMessages.push(cleanMes);
            } else {
                charMessages.push(cleanMes);
            }
        }

        const contextMap = {};
        for (let i = 0; i < userMessages.length; i++) {
            contextMap[`user${i + 1}`] = userMessages[i];
        }
        for (let i = 0; i < charMessages.length; i++) {
            contextMap[`char${i + 1}`] = charMessages[i];
        }
        return contextMap;
    }

    function stripContextMarkers(text) {
        // 移除所有 sub-api 注入的标记内容
        return text.replace(/\n?<!-- sub-api:[^:]+:start -->[\s\S]*?<!-- sub-api:[^:]+:end -->/g, '');
    }

    function replaceContextPlaceholders(text, contextMap) {
        return text.replace(/\{\{(user\d+|char\d+)\}\}/gi, (match, key) => {
            const lowerKey = key.toLowerCase();
            return contextMap[lowerKey] !== undefined ? contextMap[lowerKey] : match;
        });
    }

    // ===== Regex Processing =====
    function applyRegexList(text, regexList) {
        if (!regexList || !Array.isArray(regexList)) return text;
        let result = text;
        for (const rule of regexList) {
            if (!rule.find) continue;
            try {
                const flags = rule.flags || 'g';
                const regex = new RegExp(rule.find, flags);
                result = result.replace(regex, rule.replace || '');
            } catch (e) {
                console.warn(`[Sub-API] Invalid regex: ${rule.find}`, e);
            }
        }
        return result;
    }

    // ===== Google Gemini API Call =====
    async function callGeminiAPI(systemPrompt, userPrompt) {
        const settings = getSettings();
        if (!settings.apiKey) {
            throw new Error('API Key 未设置');
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${settings.modelName}:generateContent?key=${settings.apiKey}`;

        const body = {
            contents: [
                {
                    role: 'user',
                    parts: [{ text: userPrompt }],
                },
            ],
            systemInstruction: {
                parts: [{ text: systemPrompt }],
            },
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API 请求失败 (${response.status}): ${errText}`);
        }

        const data = await response.json();
        const candidates = data.candidates;
        if (!candidates || candidates.length === 0) {
            throw new Error('API 返回无结果');
        }

        const parts = candidates[0].content?.parts;
        if (!parts || parts.length === 0) {
            throw new Error('API 返回内容为空');
        }

        return parts.map(p => p.text || '').join('');
    }

    // ===== Write to Context =====
    function writeResultToContext(messageIndex, taskId, finalResult) {
        const { chat } = SillyTavern.getContext();
        if (messageIndex < 0 || messageIndex >= chat.length) return;

        const msg = chat[messageIndex];
        // 先移除该任务的旧标记
        msg.mes = removeTaskMarker(msg.mes, taskId);
        // 追加新结果
        const marker = `${CONTEXT_MARKER_START(taskId)}\n${finalResult}\n${CONTEXT_MARKER_END(taskId)}`;
        msg.mes = msg.mes + marker;
    }

    function removeTaskMarker(text, taskId) {
        const escapedId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`\\n?<!-- sub-api:${escapedId}:start -->[\\s\\S]*?<!-- sub-api:${escapedId}:end -->`, 'g');
        return text.replace(regex, '');
    }

    // 刷新消息DOM，让写入上下文的内容立即显示
    function reRenderMessage(messageIndex) {
        const { chat } = SillyTavern.getContext();
        const msg = chat[messageIndex];
        if (!msg) return;

        const mesBlock = getMesBlock(messageIndex);
        if (!mesBlock) return;

        const mesText = mesBlock.querySelector('.mes_text');
        if (!mesText) return;

        mesText.innerHTML = renderMarkdown(msg.mes);
    }

    // ===== Core Processing Pipeline =====
    async function processSingleTask(task, messageIndex) {
        const settings = getSettings();
        if (!settings.apiKey) return;

        const { chat } = SillyTavern.getContext();
        if (messageIndex < 0 || messageIndex >= chat.length) return;

        try {
            // Step 1: Extract context
            const contextMap = extractContextMap();

            // Step 2: Replace context placeholders
            let systemPrompt = replaceContextPlaceholders(task.systemPrompt, contextMap);
            let userPrompt = replaceContextPlaceholders(task.userPrompt, contextMap);

            // Step 3: Apply input regex
            systemPrompt = applyRegexList(systemPrompt, task.inputRegexList);
            userPrompt = applyRegexList(userPrompt, task.inputRegexList);

            // Step 4: Call Gemini API
            let apiResult = await callGeminiAPI(systemPrompt, userPrompt);

            // Step 5: Apply output regex
            apiResult = applyRegexList(apiResult, task.outputRegexList);

            // Step 6: Apply final regex
            let finalResult = applyRegexList(apiResult, task.finalRegexList);

            // Step 7: Store result
            const results = getChatResults();
            if (!results[messageIndex]) results[messageIndex] = {};
            results[messageIndex][task.id] = {
                result: finalResult,
                timestamp: Date.now(),
            };

            // Step 8: Write to context if enabled
            if (task.writeToContext) {
                writeResultToContext(messageIndex, task.id, finalResult);
            }

            // 不阻塞等待保存，让UI立即更新
            return { success: true, taskId: task.id };
        } catch (err) {
            console.error(`[Sub-API] Task "${task.name}" error:`, err);

            // Store error
            const results = getChatResults();
            if (!results[messageIndex]) results[messageIndex] = {};
            results[messageIndex][task.id] = {
                error: err.message,
                timestamp: Date.now(),
            };

            return { success: false, taskId: task.id, error: err.message };
        }
    }

    async function processAllTasks(messageIndex) {
        const settings = getSettings();
        if (!settings.enabled || !settings.apiKey) return;

        const { chat } = SillyTavern.getContext();
        if (messageIndex < 0 || messageIndex >= chat.length) return;

        const enabledTasks = settings.tasks.filter(t => t.enabled);
        if (enabledTasks.length === 0) return;

        // Show loading only for non-writeToContext tasks
        const renderTasks = enabledTasks.filter(t => !t.writeToContext);
        if (renderTasks.length > 0) {
            renderLoadingState(messageIndex, renderTasks);
        }

        // Run all tasks in parallel
        const promises = enabledTasks.map(task => processSingleTask(task, messageIndex));
        await Promise.allSettled(promises);

        // Refresh message DOM if any task wrote to context
        const hasContextWrite = enabledTasks.some(t => t.writeToContext);
        if (hasContextWrite) {
            reRenderMessage(messageIndex);
        }

        // Re-render results (only non-writeToContext tasks will be shown)
        renderAllResults();

        // 统一保存一次，不阻塞UI
        saveChatMetadata();
    }

    async function processOneTask(taskId, messageIndex) {
        const settings = getSettings();
        if (!settings.enabled || !settings.apiKey) return;

        const task = settings.tasks.find(t => t.id === taskId);
        if (!task) return;

        if (!task.writeToContext) {
            renderLoadingStateForTask(messageIndex, task);
        }
        await processSingleTask(task, messageIndex);

        if (task.writeToContext) {
            reRenderMessage(messageIndex);
        }
        renderAllResults();

        // 保存但不阻塞
        saveChatMetadata();
    }

    // ===== Rendering =====
    function getMesBlock(messageIndex) {
        return document.querySelector(`.mes[mesid="${messageIndex}"]`);
    }

    function renderLoadingState(messageId, tasks) {
        const mesBlock = getMesBlock(messageId);
        if (!mesBlock) return;
        const mesText = mesBlock.querySelector('.mes_text');
        if (!mesText) return;

        // Remove old injected elements for this message
        mesText.querySelectorAll('[data-sub-api-task]').forEach(el => el.remove());

        for (const task of tasks) {
            const el = document.createElement('div');
            el.setAttribute('data-sub-api-task', task.id);
            el.innerHTML = `<div class="sub-api-loading">正在调用 [${escapeHtml(task.name)}]...</div>`;
            if (task.renderPosition === 'above') {
                mesText.prepend(el);
            } else {
                mesText.appendChild(el);
            }
        }
    }

    function renderLoadingStateForTask(messageId, task) {
        const mesBlock = getMesBlock(messageId);
        if (!mesBlock) return;
        const mesText = mesBlock.querySelector('.mes_text');
        if (!mesText) return;

        // Remove old element for this task
        const old = mesText.querySelector(`[data-sub-api-task="${task.id}"]`);
        if (old) old.remove();

        const el = document.createElement('div');
        el.setAttribute('data-sub-api-task', task.id);
        el.innerHTML = `<div class="sub-api-loading">正在调用 [${escapeHtml(task.name)}]...</div>`;
        if (task.renderPosition === 'above') {
            mesText.prepend(el);
        } else {
            mesText.appendChild(el);
        }
    }

    function renderAllResults() {
        const { chat } = SillyTavern.getContext();
        const results = getChatResults();
        const settings = getSettings();

        // Remove all injected sub-api elements
        document.querySelectorAll('[data-sub-api-task]').forEach(el => el.remove());

        if (!settings.enabled) return;
        if (!settings.tasks || settings.tasks.length === 0) return;

        // Collect message indices that have any task results
        const msgIndicesWithResults = [];
        for (let i = 0; i < chat.length; i++) {
            if (!chat[i].is_user && !chat[i].is_system && results[i]) {
                msgIndicesWithResults.push(i);
            }
        }

        // Only render last RENDER_LIMIT messages
        const toRender = msgIndicesWithResults.slice(-RENDER_LIMIT);

        for (const msgId of toRender) {
            const msgResults = results[msgId];
            if (!msgResults) continue;

            const mesBlock = getMesBlock(msgId);
            if (!mesBlock) continue;
            const mesText = mesBlock.querySelector('.mes_text');
            if (!mesText) continue;

            // Render each task's result (skip writeToContext tasks — already in message)
            for (const task of settings.tasks) {
                if (task.writeToContext) continue;

                const taskResult = msgResults[task.id];
                if (!taskResult) continue;

                const el = document.createElement('div');
                el.setAttribute('data-sub-api-task', task.id);

                if (taskResult.error) {
                    el.innerHTML = `<span class="sub-api-error">❌ [${escapeHtml(task.name)}] ${escapeHtml(taskResult.error)}</span>`;
                } else if (taskResult.result) {
                    el.innerHTML = renderMarkdown(taskResult.result);
                }

                if (task.renderPosition === 'above') {
                    mesText.prepend(el);
                } else {
                    mesText.appendChild(el);
                }
            }
        }
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function escapeAttr(str) {
        return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function renderMarkdown(text) {
        try {
            const { showdown, DOMPurify } = SillyTavern.libs;
            const converter = new showdown.Converter({
                simplifiedAutoLink: true,
                literalMidWordUnderscores: true,
                strikethrough: true,
                tables: true,
                parseImgDimensions: true,
                openLinksInNewWindow: true,
            });
            const html = converter.makeHtml(text);
            return DOMPurify.sanitize(html, {
                ADD_TAGS: ['img'],
                ADD_ATTR: ['src', 'alt', 'title', 'width', 'height'],
            });
        } catch (e) {
            console.warn('[Sub-API] renderMarkdown fallback:', e);
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    }

    // ===== Event Handlers =====
    function setupEventListeners() {
        const { eventSource, event_types } = SillyTavern.getContext();

        eventSource.on(event_types.MESSAGE_SWIPED, () => {
            swipeFlag = true;
        });

        eventSource.on(event_types.MESSAGE_RECEIVED, (messageIndex) => {
            if (swipeFlag) {
                swipeFlag = false;
                return;
            }

            const settings = getSettings();
            if (!settings.enabled) return;

            const { chat } = SillyTavern.getContext();
            const idx = typeof messageIndex === 'number' ? messageIndex : chat.length - 1;
            const msg = chat[idx];

            if (msg && !msg.is_user && !msg.is_system) {
                processAllTasks(idx);
            }
        });

        eventSource.on(event_types.CHAT_CHANGED, () => {
            swipeFlag = false;
            setTimeout(() => renderAllResults(), 300);
        });

        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, () => {
            setTimeout(() => renderAllResults(), 200);
        });
    }

    // ===== Settings UI =====
    function buildSettingsUI() {
        const settings = getSettings();

        const settingsHtml = `
        <div id="sub-api-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-header" id="sub-api-drawer-toggle">
                    <b>📡 Sub-API Processor</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content" id="sub-api-drawer-content">
                    <!-- Global: Enable -->
                    <div class="sub-api-section">
                        <div class="sub-api-checkbox-row">
                            <input type="checkbox" id="sub-api-enabled" ${settings.enabled ? 'checked' : ''} />
                            <label for="sub-api-enabled">启用副API处理</label>
                        </div>
                    </div>

                    <!-- Global: API Config -->
                    <div class="sub-api-section">
                        <label for="sub-api-key">Google API Key</label>
                        <input type="text" id="sub-api-key" value="${escapeAttr(settings.apiKey)}" placeholder="输入你的 Google AI Studio API Key" />
                        <label for="sub-api-model" style="margin-top:6px;">模型名称</label>
                        <input type="text" id="sub-api-model" value="${escapeAttr(settings.modelName)}" placeholder="gemini-2.0-flash" />
                    </div>

                    <!-- Task List -->
                    <div class="sub-api-section">
                        <label>任务列表</label>
                        <div id="sub-api-task-list"></div>
                        <div class="sub-api-btn-row" style="margin-top:6px;">
                            <button class="sub-api-btn" id="sub-api-add-task">+ 添加任务</button>
                        </div>
                    </div>

                    <!-- Manual Trigger -->
                    <div class="sub-api-section">
                        <label>手动操作</label>
                        <div class="sub-api-btn-row">
                            <button class="sub-api-btn" id="sub-api-manual-all" style="flex:1;">▶ 全部任务（最新AI回复）</button>
                        </div>
                        <div id="sub-api-manual-per-task" style="margin-top:6px;"></div>
                    </div>
                </div>
            </div>
        </div>
        `;

        const extensionsBlock = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (extensionsBlock) {
            extensionsBlock.insertAdjacentHTML('beforeend', settingsHtml);
        }

        // Drawer toggle
        document.getElementById('sub-api-drawer-toggle')?.addEventListener('click', function () {
            const content = document.getElementById('sub-api-drawer-content');
            const icon = this.querySelector('.inline-drawer-icon');
            if (content) content.classList.toggle('open');
            if (icon) { icon.classList.toggle('up'); icon.classList.toggle('down'); }
        });

        // Global events
        document.getElementById('sub-api-enabled')?.addEventListener('change', function () {
            getSettings().enabled = this.checked;
            saveSettings();
            renderAllResults();
        });
        document.getElementById('sub-api-key')?.addEventListener('input', function () {
            getSettings().apiKey = this.value;
            saveSettings();
        });
        document.getElementById('sub-api-model')?.addEventListener('input', function () {
            getSettings().modelName = this.value;
            saveSettings();
        });

        // Add task button
        document.getElementById('sub-api-add-task')?.addEventListener('click', () => {
            const s = getSettings();
            s.tasks.push(createDefaultTask());
            saveSettings();
            renderTaskList();
        });

        // Manual trigger all
        document.getElementById('sub-api-manual-all')?.addEventListener('click', () => {
            const { chat } = SillyTavern.getContext();
            for (let i = chat.length - 1; i >= 0; i--) {
                if (!chat[i].is_user && !chat[i].is_system) {
                    processAllTasks(i);
                    return;
                }
            }
        });

        renderTaskList();
    }

    function renderTaskList() {
        const s = getSettings();
        const container = document.getElementById('sub-api-task-list');
        const manualContainer = document.getElementById('sub-api-manual-per-task');
        if (!container) return;
        container.innerHTML = '';
        if (manualContainer) manualContainer.innerHTML = '';

        s.tasks.forEach((task, tIdx) => {
            const taskEl = document.createElement('div');
            taskEl.classList.add('sub-api-task-block');

            taskEl.innerHTML = `
                <div class="sub-api-task-header">
                    <div class="sub-api-checkbox-row">
                        <input type="checkbox" class="task-enabled" ${task.enabled ? 'checked' : ''} />
                        <input type="text" class="task-name-input" value="${escapeAttr(task.name)}" placeholder="任务名称" />
                    </div>
                    <div class="sub-api-task-header-btns">
                        <button class="sub-api-btn task-toggle-detail" title="展开/收起">▼</button>
                        <button class="sub-api-btn danger task-delete" title="删除任务">✕</button>
                    </div>
                </div>
                <div class="sub-api-task-detail" style="display:none;">
                    <!-- Render Position -->
                    <div style="margin-bottom:6px;">
                        <label>渲染位置</label>
                        <select class="task-render-pos">
                            <option value="below" ${task.renderPosition === 'below' ? 'selected' : ''}>AI消息下方</option>
                            <option value="above" ${task.renderPosition === 'above' ? 'selected' : ''}>AI消息上方</option>
                        </select>
                    </div>
                    <!-- Write to Context -->
                    <div class="sub-api-checkbox-row" style="margin-bottom:6px;">
                        <input type="checkbox" class="task-write-ctx" ${task.writeToContext ? 'checked' : ''} />
                        <label>将结果写入上下文（与AI消息合并）</label>
                    </div>
                    <!-- System Prompt -->
                    <label>系统提示词 <span style="font-weight:normal;font-size:0.8em;color:#888;">（{{user1}} {{char1}} ...）</span></label>
                    <textarea class="task-sys-prompt" rows="3">${escapeHtml(task.systemPrompt)}</textarea>
                    <!-- User Prompt -->
                    <label>用户提示词 <span style="font-weight:normal;font-size:0.8em;color:#888;">（{{user1}} {{char1}} ...）</span></label>
                    <textarea class="task-user-prompt" rows="3">${escapeHtml(task.userPrompt)}</textarea>
                    <!-- Input Regex -->
                    <label>输入正则</label>
                    <div class="task-input-regex-list"></div>
                    <button class="sub-api-btn task-add-input-regex">+ 输入正则</button>
                    <!-- Output Regex -->
                    <label style="margin-top:6px;">输出正则</label>
                    <div class="task-output-regex-list"></div>
                    <button class="sub-api-btn task-add-output-regex">+ 输出正则</button>
                    <!-- Final Regex -->
                    <label style="margin-top:6px;">最终正则</label>
                    <div class="task-final-regex-list"></div>
                    <button class="sub-api-btn task-add-final-regex">+ 最终正则</button>
                </div>
            `;

            // === Bind events ===
            // Enable
            taskEl.querySelector('.task-enabled').addEventListener('change', function () {
                task.enabled = this.checked;
                saveSettings();
            });
            // Name
            taskEl.querySelector('.task-name-input').addEventListener('input', function () {
                task.name = this.value;
                saveSettings();
                renderManualPerTask();
            });
            // Toggle detail
            const detailEl = taskEl.querySelector('.sub-api-task-detail');
            taskEl.querySelector('.task-toggle-detail').addEventListener('click', function () {
                const open = detailEl.style.display !== 'none';
                detailEl.style.display = open ? 'none' : 'flex';
                this.textContent = open ? '▼' : '▲';
            });
            // Delete
            taskEl.querySelector('.task-delete').addEventListener('click', () => {
                s.tasks.splice(tIdx, 1);
                saveSettings();
                renderTaskList();
                renderAllResults();
            });
            // Render Position
            taskEl.querySelector('.task-render-pos').addEventListener('change', function () {
                task.renderPosition = this.value;
                saveSettings();
                renderAllResults();
            });
            // Write to context
            taskEl.querySelector('.task-write-ctx').addEventListener('change', function () {
                task.writeToContext = this.checked;
                saveSettings();
            });
            // System / User prompt
            taskEl.querySelector('.task-sys-prompt').addEventListener('input', function () {
                task.systemPrompt = this.value;
                saveSettings();
            });
            taskEl.querySelector('.task-user-prompt').addEventListener('input', function () {
                task.userPrompt = this.value;
                saveSettings();
            });

            // Regex buttons
            taskEl.querySelector('.task-add-input-regex').addEventListener('click', () => {
                task.inputRegexList.push({ find: '', replace: '', flags: 'g' });
                saveSettings();
                renderRegexListInTask(taskEl, task, 'input');
            });
            taskEl.querySelector('.task-add-output-regex').addEventListener('click', () => {
                task.outputRegexList.push({ find: '', replace: '', flags: 'g' });
                saveSettings();
                renderRegexListInTask(taskEl, task, 'output');
            });
            taskEl.querySelector('.task-add-final-regex').addEventListener('click', () => {
                task.finalRegexList.push({ find: '', replace: '', flags: 'g' });
                saveSettings();
                renderRegexListInTask(taskEl, task, 'final');
            });

            container.appendChild(taskEl);

            // Render regex lists
            renderRegexListInTask(taskEl, task, 'input');
            renderRegexListInTask(taskEl, task, 'output');
            renderRegexListInTask(taskEl, task, 'final');
        });

        renderManualPerTask();
    }

    function renderManualPerTask() {
        const s = getSettings();
        const manualContainer = document.getElementById('sub-api-manual-per-task');
        if (!manualContainer) return;
        manualContainer.innerHTML = '';

        s.tasks.forEach(task => {
            const btn = document.createElement('button');
            btn.classList.add('sub-api-btn');
            btn.style.width = '100%';
            btn.style.marginBottom = '4px';
            btn.textContent = `🔄 ${task.name}（最新AI回复）`;
            btn.addEventListener('click', () => {
                const { chat } = SillyTavern.getContext();
                for (let i = chat.length - 1; i >= 0; i--) {
                    if (!chat[i].is_user && !chat[i].is_system) {
                        processOneTask(task.id, i);
                        return;
                    }
                }
            });
            manualContainer.appendChild(btn);
        });
    }

    function renderRegexListInTask(taskEl, task, type) {
        const listKey = `${type}RegexList`;
        const containerClass = `task-${type}-regex-list`;
        const container = taskEl.querySelector(`.${containerClass}`);
        if (!container) return;

        const list = task[listKey] || [];
        container.innerHTML = '';

        list.forEach((rule, index) => {
            const group = document.createElement('div');
            group.classList.add('sub-api-regex-group');
            group.innerHTML = `
                <div class="regex-row">
                    <span class="regex-label">查找：</span>
                    <input type="text" class="regex-find" value="${escapeAttr(rule.find)}" placeholder="正则表达式" />
                </div>
                <div class="regex-row">
                    <span class="regex-label">替换：</span>
                    <input type="text" class="regex-replace" value="${escapeAttr(rule.replace)}" placeholder="替换文本 ($1 $2 ...)" />
                </div>
                <div class="regex-row">
                    <span class="regex-label">标志：</span>
                    <input type="text" class="regex-flags" value="${escapeAttr(rule.flags || 'g')}" placeholder="g" style="max-width:80px;" />
                    <button class="sub-api-btn danger regex-delete" title="删除">✕</button>
                </div>
            `;

            group.querySelector('.regex-find').addEventListener('input', function () {
                task[listKey][index].find = this.value;
                saveSettings();
            });
            group.querySelector('.regex-replace').addEventListener('input', function () {
                task[listKey][index].replace = this.value;
                saveSettings();
            });
            group.querySelector('.regex-flags').addEventListener('input', function () {
                task[listKey][index].flags = this.value;
                saveSettings();
            });
            group.querySelector('.regex-delete').addEventListener('click', () => {
                task[listKey].splice(index, 1);
                saveSettings();
                renderRegexListInTask(taskEl, task, type);
            });

            container.appendChild(group);
        });
    }

    // ===== Initialize =====
    function init() {
        buildSettingsUI();
        setupEventListeners();
        setTimeout(() => renderAllResults(), 500);
        console.log('[Sub-API Processor] Extension loaded.');
    }

    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
        const { eventSource, event_types } = SillyTavern.getContext();
        eventSource.on(event_types.APP_READY, () => init());
    }
})();
