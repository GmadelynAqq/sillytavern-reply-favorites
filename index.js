import { extension_settings } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    openCharacterChat,
    saveSettingsDebounced,
    selectCharacterById,
} from '../../../../script.js';
import { openGroupById, openGroupChat } from '../../../group-chats.js';
import { Popup } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';

const EXTENSION_KEY = 'replyFavorites';
const FAVORITE_ID_KEY = 'reply_favorite_id';
const MAX_CANVAS_HEIGHT = 15000;
const IMAGE_WIDTH = 1200;
const settingsDefaults = Object.freeze({
    version: 2,
    items: [],
    collections: [],
    sort: 'newest',
    defaultCapture: 'previous-user',
});

let filteredItems = [];
const selectedIds = new Set();

function getContext() {
    return SillyTavern.getContext();
}

function getSettings() {
    if (!extension_settings[EXTENSION_KEY] || typeof extension_settings[EXTENSION_KEY] !== 'object') {
        extension_settings[EXTENSION_KEY] = structuredClone(settingsDefaults);
    }
    const settings = extension_settings[EXTENSION_KEY];
    settings.items = Array.isArray(settings.items) ? settings.items.map(normalizeItem) : [];
    settings.collections = Array.isArray(settings.collections) ? [...new Set(settings.collections.map(cleanText).filter(Boolean))] : [];
    settings.sort = ['newest', 'oldest', 'story-newest', 'character', 'title'].includes(settings.sort) ? settings.sort : 'newest';
    settings.defaultCapture = ['current', 'previous-user', '3', '5'].includes(settings.defaultCapture)
        ? settings.defaultCapture
        : 'previous-user';
    settings.version = 2;
    return settings;
}

function saveFavorites() {
    saveSettingsDebounced();
}

function createId() {
    return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cleanText(value) {
    return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function normalizeItem(value) {
    const item = value && typeof value === 'object' ? value : {};
    item.id ||= createId();
    item.createdAt ||= new Date().toISOString();
    item.characterName = cleanText(item.characterName) || '未知角色';
    item.characterKey = cleanText(item.characterKey) || item.characterName;
    item.avatar = String(item.avatar || '');
    item.text = cleanText(item.text);
    item.userPrompt = cleanText(item.userPrompt);
    item.title = cleanText(item.title);
    item.note = cleanText(item.note);
    item.tags = Array.isArray(item.tags) ? [...new Set(item.tags.map(cleanText).filter(Boolean))] : [];
    item.collections = Array.isArray(item.collections) ? [...new Set(item.collections.map(cleanText).filter(Boolean))] : [];
    item.source = item.source && typeof item.source === 'object' ? item.source : {};
    item.source.messageIndex = Number.isFinite(Number(item.source.messageIndex)) ? Number(item.source.messageIndex) : 0;
    if (!Array.isArray(item.messages) || !item.messages.length) {
        item.messages = [];
        if (item.userPrompt) item.messages.push({ name: '你', isUser: true, text: item.userPrompt, messageIndex: Math.max(0, item.source.messageIndex - 1) });
        if (item.text) item.messages.push({ name: item.characterName, isUser: false, text: item.text, messageIndex: item.source.messageIndex });
    } else {
        item.messages = item.messages.map(message => ({
            name: cleanText(message?.name) || (message?.isUser ? '你' : item.characterName),
            isUser: Boolean(message?.isUser),
            text: cleanText(message?.text),
            messageIndex: Number.isFinite(Number(message?.messageIndex)) ? Number(message.messageIndex) : item.source.messageIndex,
        })).filter(message => message.text);
    }
    return item;
}

function plainText(value) {
    return cleanText(value)
        .replace(/```[\s\S]*?```/g, block => block.replace(/^```[^\n]*\n?|\n?```$/g, ''))
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/(^|\s)[#>*_~`]+/gm, '$1')
        .replace(/\n{3,}/g, '\n\n');
}

function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '时间未知';
    return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
    }).format(date);
}

function getCharacterKey(context, message, messageElement) {
    if (context.groupId) {
        return messageElement.attr('ch_name') || message?.name || '群聊角色';
    }
    return context.characters[context.characterId]?.avatar
        || messageElement.attr('ch_name')
        || message?.name
        || '未知角色';
}

function getCharacterName(context, message, messageElement) {
    return messageElement.attr('ch_name')
        || message?.name
        || context.characters[context.characterId]?.name
        || '未知角色';
}

function findPreviousUserMessage(chat, messageIndex) {
    for (let index = messageIndex - 1; index >= 0; index--) {
        if (chat[index]?.is_user) return cleanText(chat[index].mes);
    }
    return '';
}

function getCaptureIndexes(chat, messageIndex, captureMode) {
    if (captureMode === 'current') return [messageIndex];
    if (captureMode === 'previous-user') {
        for (let index = messageIndex - 1; index >= 0; index--) {
            if (chat[index]?.is_user) return [index, messageIndex];
        }
        return [messageIndex];
    }
    const count = Number(captureMode);
    return Array.from({ length: Math.min(count, messageIndex + 1) }, (_, offset) => messageIndex - Math.min(count - 1, messageIndex) + offset);
}

async function chooseCaptureIndexes(chat, messageIndex, customRange) {
    if (!customRange) return getCaptureIndexes(chat, messageIndex, getSettings().defaultCapture);
    const answer = await Popup.show.input(
        '收藏连续楼层',
        `输入楼层范围，例如 12-15。当前角色回复是第 ${messageIndex + 1} 层。`,
        `${Math.max(1, messageIndex)}-${messageIndex + 1}`,
    );
    if (answer === null || answer === undefined) return null;
    const match = String(answer).trim().match(/^(\d+)(?:\s*[-—~至]\s*(\d+))?$/);
    if (!match) {
        toastr.warning('请输入如 12-15 的连续楼层范围');
        return null;
    }
    const first = Math.min(chat.length, Math.max(1, Number(match[1])));
    const second = Math.min(chat.length, Math.max(1, Number(match[2] || match[1])));
    const start = Math.min(first, second);
    const end = Math.max(first, second);
    return Array.from({ length: end - start + 1 }, (_, offset) => start - 1 + offset);
}

function buildCapturedMessages(chat, indexes, fallbackName) {
    return indexes.map(index => ({
        name: cleanText(chat[index]?.name) || (chat[index]?.is_user ? '你' : fallbackName),
        isUser: Boolean(chat[index]?.is_user),
        text: cleanText(chat[index]?.mes),
        messageIndex: index,
    })).filter(message => message.text);
}

function duplicateKey(item) {
    const source = item.source || {};
    const indexes = (item.messages || []).map(message => message.messageIndex).join(',');
    return [source.groupId || source.characterAvatar || source.characterName, source.chatId, indexes, item.text].join('¦');
}

function findFavoriteByMessage(message) {
    const favoriteId = message?.extra?.[FAVORITE_ID_KEY];
    return favoriteId ? getSettings().items.find(item => item.id === favoriteId) : null;
}

async function toggleFavorite(messageIndex, button, customRange = false) {
    const context = getContext();
    const message = context.chat[messageIndex];
    if (!message || message.is_user || message.is_system) return;

    const existing = findFavoriteByMessage(message);
    if (existing) {
        await removeFavorite(existing.id);
        return;
    }

    const messageElement = button.closest('.mes');
    const captureIndexes = await chooseCaptureIndexes(context.chat, messageIndex, customRange);
    if (!captureIndexes) return;
    const characterName = getCharacterName(context, message, messageElement);
    const messages = buildCapturedMessages(context.chat, captureIndexes, characterName);
    const favorite = {
        id: createId(),
        createdAt: new Date().toISOString(),
        messageDate: message.send_date || '',
        characterName,
        characterKey: getCharacterKey(context, message, messageElement),
        avatar: messageElement.find('.avatar img').attr('src') || '',
        text: cleanText(message.mes),
        userPrompt: findPreviousUserMessage(context.chat, messageIndex),
        title: '',
        note: '',
        tags: [],
        collections: [],
        messages,
        source: {
            chatId: context.chatId || '',
            characterAvatar: context.groupId ? '' : (context.characters[context.characterId]?.avatar || ''),
            characterName: context.groupId ? '' : (context.characters[context.characterId]?.name || ''),
            groupId: context.groupId || '',
            groupName: context.groupId
                ? (context.groups.find(group => String(group.id) === String(context.groupId))?.name || '')
                : '',
            messageIndex,
        },
    };

    const duplicate = getSettings().items.find(item => duplicateKey(item) === duplicateKey(favorite));
    if (duplicate) {
        message.extra ??= {};
        message.extra[FAVORITE_ID_KEY] = duplicate.id;
        if (context.chatId) await context.saveChat();
        enhanceMessages();
        toastr.info('这段内容已经收藏过，已重新关联原收藏');
        return;
    }

    message.extra ??= {};
    message.extra[FAVORITE_ID_KEY] = favorite.id;
    getSettings().items.unshift(favorite);
    saveFavorites();
    if (context.chatId) await context.saveChat();
    enhanceMessages();
    if ($('#rf-overlay').hasClass('rf-open')) renderGallery();
    toastr.success('已收进回复珍藏馆', favorite.characterName);
}

async function removeFavorite(id, ask = false) {
    const item = getSettings().items.find(entry => entry.id === id);
    if (!item) return;
    if (ask && !await Popup.show.confirm('移出珍藏馆', `确定移除「${escapeHtml(item.characterName)}」的这条收藏吗？`)) return;

    extension_settings[EXTENSION_KEY].items = getSettings().items.filter(entry => entry.id !== id);
    selectedIds.delete(id);

    const context = getContext();
    const currentMessage = context.chat.find(message => message?.extra?.[FAVORITE_ID_KEY] === id);
    if (currentMessage?.extra) {
        delete currentMessage.extra[FAVORITE_ID_KEY];
        if (context.chatId) await context.saveChat();
    }

    saveFavorites();
    enhanceMessages();
    renderGallery();
}

function enhanceMessages() {
    const context = getContext();
    $('#chat .mes').each(function () {
        const messageElement = $(this);
        const messageIndex = Number(messageElement.attr('mesid'));
        const message = context.chat[messageIndex];
        if (!message || message.is_user || message.is_system) {
            messageElement.find('.rf-message-favorite').remove();
            return;
        }

        let button = messageElement.find('.rf-message-favorite');
        if (!button.length) {
            button = $('<div class="mes_button rf-message-favorite fa-solid fa-star" title="收藏这条回复"></div>');
            messageElement.find('.mes_buttons > .mes_edit').before(button);
        }
        const active = Boolean(findFavoriteByMessage(message));
        button.toggleClass('rf-favorited', active)
            .attr('title', active ? '取消收藏' : '收藏这条回复');
    });
}

function galleryMarkup() {
    return `
        <div id="rf-overlay" aria-hidden="true">
            <section id="rf-gallery" role="dialog" aria-modal="true" aria-label="回复珍藏馆">
                <header class="rf-header">
                    <div>
                        <div class="rf-eyebrow">ROLEPLAY KEEPSAKES</div>
                        <h2>回复珍藏馆</h2>
                        <p>把舍不得滑过去的那一层，留在这里。</p>
                    </div>
                    <button class="rf-icon-button" id="rf-close" title="关闭"><i class="fa-solid fa-xmark"></i></button>
                </header>
                <div class="rf-toolbar">
                    <label class="rf-search">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input id="rf-search-input" type="search" placeholder="搜索标题、正文、角色、合集或标签">
                    </label>
                    <select id="rf-character-filter" title="按角色筛选"><option value="">所有角色</option></select>
                    <select id="rf-collection-filter" title="按合集筛选"><option value="">所有合集</option></select>
                    <select id="rf-sort" title="排序">
                        <option value="newest">最近收藏</option>
                        <option value="oldest">最早收藏</option>
                        <option value="story-newest">故事楼层</option>
                        <option value="character">角色名称</option>
                        <option value="title">收藏标题</option>
                    </select>
                    <label class="rf-select-all"><input id="rf-select-all" type="checkbox"> 全选当前结果</label>
                </div>
                <div class="rf-actionbar">
                    <span><b id="rf-count"></b><small id="rf-storage"></small></span>
                    <span class="rf-export-hint">有勾选时导出勾选项，否则导出当前筛选结果</span>
                    <button id="rf-random" class="menu_button"><i class="fa-solid fa-shuffle"></i> 随机重温</button>
                    <button id="rf-export-md" class="menu_button"><i class="fa-brands fa-markdown"></i> Markdown</button>
                    <button id="rf-export-image" class="menu_button"><i class="fa-solid fa-image"></i> 拼成长图</button>
                    <details class="rf-data-menu">
                        <summary class="menu_button"><i class="fa-solid fa-database"></i> 数据</summary>
                        <div>
                            <button id="rf-export-json" class="menu_button">导出备份</button>
                            <button class="menu_button rf-import-json" data-mode="merge">合并导入</button>
                            <button class="menu_button rf-import-json" data-mode="replace">覆盖恢复</button>
                            <button id="rf-dedupe" class="menu_button">清理重复</button>
                            <button id="rf-delete-selected" class="menu_button rf-danger">删除所选</button>
                        </div>
                    </details>
                    <input id="rf-import-file" type="file" accept="application/json,.json" hidden>
                </div>
                <main id="rf-list"></main>
            </section>
        </div>
        <button id="rf-open-fab" title="打开回复珍藏馆" aria-label="打开回复珍藏馆">
            <i class="fa-solid fa-star"></i><span>珍藏馆</span>
        </button>`;
}

function settingsMarkup() {
    return `
        <div class="inline-drawer rf-settings">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>回复珍藏馆</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <p>点击角色回复的星星即可收藏；Shift + 点击可自选连续楼层。收藏保留文本快照，可导出 Markdown、图片或 JSON 备份。</p>
                <label class="rf-setting-row">默认收藏范围
                    <select id="rf-default-capture">
                        <option value="current">仅当前回复</option>
                        <option value="previous-user">上一条用户消息 + 当前回复</option>
                        <option value="3">最近 3 层</option>
                        <option value="5">最近 5 层</option>
                    </select>
                </label>
                <button id="rf-open-settings" class="menu_button"><i class="fa-solid fa-star"></i> 打开珍藏馆</button>
            </div>
        </div>`;
}

function getFilterValues() {
    return {
        query: cleanText($('#rf-search-input').val()).toLocaleLowerCase(),
        character: String($('#rf-character-filter').val() || ''),
        collection: String($('#rf-collection-filter').val() || ''),
    };
}

function updateCharacterFilter() {
    const current = String($('#rf-character-filter').val() || '');
    const names = [...new Set(getSettings().items.map(item => item.characterName).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    $('#rf-character-filter').html('<option value="">所有角色</option>' + names
        .map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
        .join(''));
    $('#rf-character-filter').val(names.includes(current) ? current : '');
}

function updateCollectionFilter() {
    const current = String($('#rf-collection-filter').val() || '');
    const collections = [...new Set([
        ...getSettings().collections,
        ...getSettings().items.flatMap(item => item.collections || []),
    ])].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    $('#rf-collection-filter').html('<option value="">所有合集</option>' + collections
        .map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join(''));
    $('#rf-collection-filter').val(collections.includes(current) ? current : '');
}

function getFilteredItems() {
    const { query, character, collection } = getFilterValues();
    const result = getSettings().items.filter(item => {
        if (character && item.characterName !== character) return false;
        if (collection && !item.collections?.includes(collection)) return false;
        if (!query) return true;
        const haystack = [
            item.title,
            item.characterName,
            item.text,
            item.userPrompt,
            item.note,
            ...(item.tags || []),
            ...(item.collections || []),
            ...(item.messages || []).flatMap(message => [message.name, message.text]),
        ].join('\n').toLocaleLowerCase();
        return haystack.includes(query);
    });
    const sort = getSettings().sort;
    return result.sort((a, b) => {
        if (sort === 'oldest') return new Date(a.createdAt) - new Date(b.createdAt);
        if (sort === 'story-newest') return Number(b.source?.messageIndex || 0) - Number(a.source?.messageIndex || 0);
        if (sort === 'character') return a.characterName.localeCompare(b.characterName, 'zh-CN');
        if (sort === 'title') return (a.title || a.characterName).localeCompare(b.title || b.characterName, 'zh-CN');
        return new Date(b.createdAt) - new Date(a.createdAt);
    });
}

function formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
}

function getSourceState(item) {
    if (!item.source?.chatId) return { broken: true, text: '来源信息不完整' };
    const context = getContext();
    if (item.source.groupId) {
        const exists = context.groups?.some(group => String(group.id) === String(item.source.groupId));
        return exists ? { broken: false, text: '来源已记录' } : { broken: true, text: '原群聊角色已不存在' };
    }
    const exists = context.characters?.some(character =>
        character.avatar === item.source.characterAvatar
        || (!item.source.characterAvatar && character.name === item.source.characterName));
    return exists ? { broken: false, text: '来源已记录' } : { broken: true, text: '原角色已不存在' };
}

function capturedMessagesMarkup(item) {
    const messages = item.messages || [];
    if (messages.length <= 1) {
        return `<div class="rf-message">${escapeHtml(item.text).replace(/\n/g, '<br>')}</div>`;
    }
    return `<div class="rf-captured">${messages.map(message => `
        <div class="rf-captured-message ${message.isUser ? 'rf-user' : 'rf-character'}">
            <span>${escapeHtml(message.name)} · 第 ${Number(message.messageIndex) + 1} 层</span>
            <div>${escapeHtml(message.text).replace(/\n/g, '<br>')}</div>
        </div>`).join('')}</div>`;
}

function renderGallery() {
    if (!$('#rf-list').length) return;
    updateCharacterFilter();
    updateCollectionFilter();
    $('#rf-sort').val(getSettings().sort);
    filteredItems = getFilteredItems();
    const list = $('#rf-list');
    $('#rf-count').text(`${filteredItems.length} 条珍藏 · 已选 ${selectedIds.size} 条`);
    const storageBytes = new Blob([JSON.stringify(getSettings())]).size;
    $('#rf-storage').text(`占用 ${formatBytes(storageBytes)}`).toggleClass('rf-storage-warning', storageBytes > 2 * 1024 * 1024);
    $('#rf-select-all').prop('checked', filteredItems.length > 0 && filteredItems.every(item => selectedIds.has(item.id)));

    if (!filteredItems.length) {
        list.html(`
            <div class="rf-empty">
                <i class="fa-regular fa-star"></i>
                <h3>这里还空着</h3>
                <p>回到聊天，在喜欢的角色回复右上角点一下星星吧。</p>
            </div>`);
        return;
    }

    list.html(filteredItems.map(item => {
        const sourceState = getSourceState(item);
        return `
        <article class="rf-card" data-favorite-id="${escapeHtml(item.id)}">
            <div class="rf-card-top">
                <label class="rf-card-check" title="选择"><input type="checkbox" ${selectedIds.has(item.id) ? 'checked' : ''}></label>
                <div class="rf-avatar">${item.avatar ? `<img src="${escapeHtml(item.avatar)}" alt="">` : '<i class="fa-solid fa-user"></i>'}</div>
                <div class="rf-card-identity">
                    <strong>${escapeHtml(item.title || item.characterName)}</strong>
                    <span>${escapeHtml(formatDate(item.createdAt))} · ${escapeHtml(item.source?.chatId || '未知聊天')}</span>
                    ${item.title ? `<small>来自 ${escapeHtml(item.characterName)}</small>` : ''}
                </div>
                <span class="rf-source-state ${sourceState.broken ? 'rf-broken' : ''}" title="${escapeHtml(sourceState.text)}">
                    <i class="fa-solid ${sourceState.broken ? 'fa-link-slash' : 'fa-link'}"></i>
                </span>
                <div class="rf-card-actions">
                    <button class="rf-card-button rf-jump" title="回到原聊天"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
                    <button class="rf-card-button rf-card-image" title="导出这张卡片"><i class="fa-solid fa-image"></i></button>
                    <button class="rf-card-button rf-remove" title="移出珍藏馆"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </div>
            ${capturedMessagesMarkup(item)}
            <div class="rf-fields">
                <label><span>标题</span><input class="rf-title" value="${escapeHtml(item.title || '')}" placeholder="给这段回忆起个名字"></label>
                <label><span>合集</span><input class="rf-collections" value="${escapeHtml((item.collections || []).join('，'))}" placeholder="主线，高光片段"></label>
                <label><span>标签</span><input class="rf-tags" value="${escapeHtml((item.tags || []).join('，'))}" placeholder="甜，高光，文笔"></label>
                <label><span>备注</span><textarea class="rf-note" rows="2" placeholder="为什么喜欢这一段……">${escapeHtml(item.note || '')}</textarea></label>
            </div>
        </article>`;
    }).join(''));
}

function openGallery() {
    $('#rf-overlay').addClass('rf-open').attr('aria-hidden', 'false');
    renderGallery();
    setTimeout(() => $('#rf-search-input').trigger('focus'), 50);
}

function closeGallery() {
    $('#rf-overlay').removeClass('rf-open').attr('aria-hidden', 'true');
}

function getExportItems(singleId = null) {
    if (singleId) return getSettings().items.filter(item => item.id === singleId);
    const selected = getSettings().items.filter(item => selectedIds.has(item.id));
    return selected.length ? selected : filteredItems;
}

function safeFilename(value) {
    return String(value || '回复珍藏')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .slice(0, 80);
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportMarkdown() {
    const items = getExportItems();
    if (!items.length) {
        toastr.info('当前没有可导出的收藏');
        return;
    }

    const lines = ['# 回复珍藏馆', '', `导出时间：${formatDate(new Date().toISOString())}`, ''];
    for (const item of items) {
        lines.push(`## ${item.title || item.characterName}`, '');
        if (item.title) lines.push(`- 角色：${item.characterName}`);
        lines.push(`- 收藏时间：${formatDate(item.createdAt)}`);
        lines.push(`- 来源聊天：${item.source?.chatId || '未知'}`);
        if (item.collections?.length) lines.push(`- 合集：${item.collections.join('、')}`);
        if (item.tags?.length) lines.push(`- 标签：${item.tags.join('、')}`);
        lines.push('');
        if (item.messages?.length > 1) {
            lines.push('### 收藏片段', '');
            for (const message of item.messages) {
                lines.push(`**${message.name}（第 ${Number(message.messageIndex) + 1} 层）**`, '', message.text, '');
            }
        } else {
            if (item.userPrompt) {
                lines.push('### 当时你说', '', ...item.userPrompt.split('\n').map(line => `> ${line}`), '');
            }
            lines.push('### 角色回复', '', item.text, '');
        }
        if (item.note) lines.push('### 备注', '', item.note, '');
        lines.push('---', '');
    }

    downloadBlob(new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }), `回复珍藏馆-${dateStamp()}.md`);
}

function dateStamp() {
    const date = new Date();
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function splitText(context, text, maxWidth) {
    const lines = [];
    const paragraphs = plainText(text).split('\n');
    for (const paragraph of paragraphs) {
        if (!paragraph) {
            lines.push('');
            continue;
        }
        let line = '';
        for (const character of Array.from(paragraph)) {
            const candidate = line + character;
            if (line && context.measureText(candidate).width > maxWidth) {
                lines.push(line);
                line = character;
            } else {
                line = candidate;
            }
        }
        if (line) lines.push(line);
    }
    return lines;
}

function roundedRect(context, x, y, width, height, radius) {
    context.beginPath();
    context.roundRect(x, y, width, height, radius);
}

function buildImageLayout(item, measureContext) {
    const contentWidth = IMAGE_WIDTH - 176;
    measureContext.font = '34px "Microsoft YaHei", "PingFang SC", sans-serif';
    const rangeText = item.messages?.length > 1
        ? item.messages.map(message => `【${message.name} · 第 ${Number(message.messageIndex) + 1} 层】\n${message.text}`).join('\n\n')
        : item.text;
    const reply = splitText(measureContext, rangeText, contentWidth);
    measureContext.font = '25px "Microsoft YaHei", "PingFang SC", sans-serif';
    const prompt = item.messages?.length > 1 ? [] : (item.userPrompt ? splitText(measureContext, item.userPrompt, contentWidth - 48) : []);
    const note = item.note ? splitText(measureContext, item.note, contentWidth - 48) : [];
    const tags = item.tags?.length ? item.tags.join(' · ') : '';
    const height = 178
        + reply.length * 53
        + (prompt.length ? 66 + prompt.length * 39 : 0)
        + (tags ? 58 : 0)
        + (note.length ? 70 + note.length * 39 : 0)
        + 92;
    return { item, reply, prompt, note, tags, height: Math.max(420, height + (item.title ? 34 : 0)) };
}

function splitOversizedLayout(layout, measureContext) {
    if (layout.height <= MAX_CANVAS_HEIGHT - 260) return [layout];

    const lines = [];
    if (layout.prompt.length) lines.push('【当时你说】', ...layout.prompt, '');
    lines.push('【角色回复】', ...layout.reply);
    if (layout.tags) lines.push('', `【标签】${layout.tags}`);
    if (layout.note.length) lines.push('', '【收藏备注】', ...layout.note);

    const chunks = [];
    const linesPerPage = 200;
    for (let index = 0; index < lines.length; index += linesPerPage) {
        chunks.push(lines.slice(index, index + linesPerPage));
    }

    return chunks.map((chunk, index) => buildImageLayout({
        ...layout.item,
        characterName: index ? `${layout.item.characterName}（续）` : layout.item.characterName,
        text: chunk.join('\n'),
        userPrompt: '',
        tags: [],
        note: '',
    }, measureContext));
}

async function loadImage(url) {
    if (!url) return null;
    return await new Promise(resolve => {
        const image = new Image();
        image.crossOrigin = 'anonymous';
        image.onload = () => resolve(image);
        image.onerror = () => resolve(null);
        image.src = url;
    });
}

function drawLines(context, lines, x, y, lineHeight, color) {
    context.fillStyle = color;
    lines.forEach((line, index) => context.fillText(line, x, y + index * lineHeight));
}

function drawFavoriteCard(context, layout, y, avatar) {
    const { item, reply, prompt, note, tags, height } = layout;
    const x = 48;
    const width = IMAGE_WIDTH - 96;

    context.save();
    context.shadowColor = 'rgba(77, 52, 42, .10)';
    context.shadowBlur = 24;
    context.shadowOffsetY = 8;
    context.fillStyle = '#fffdf9';
    roundedRect(context, x, y, width, height, 34);
    context.fill();
    context.restore();

    if (avatar) {
        context.save();
        roundedRect(context, x + 40, y + 38, 76, 76, 24);
        context.clip();
        context.drawImage(avatar, x + 40, y + 38, 76, 76);
        context.restore();
    } else {
        context.fillStyle = '#d7b7a9';
        roundedRect(context, x + 40, y + 38, 76, 76, 24);
        context.fill();
        context.fillStyle = '#fffaf6';
        context.font = '700 34px serif';
        context.textAlign = 'center';
        context.fillText('✦', x + 78, y + 89);
        context.textAlign = 'left';
    }

    context.fillStyle = '#382b28';
    context.font = '700 34px "Microsoft YaHei", "PingFang SC", sans-serif';
    context.fillText(item.title || item.characterName, x + 140, y + 72);
    context.fillStyle = '#9a8178';
    context.font = '23px "Microsoft YaHei", "PingFang SC", sans-serif';
    const imageMeta = item.title ? `${item.characterName}  ·  ${formatDate(item.createdAt)}` : `${formatDate(item.createdAt)}  ·  ${item.source?.chatId || '未知聊天'}`;
    context.fillText(imageMeta, x + 140, y + 106);

    let cursorY = y + 164;
    if (prompt.length) {
        const promptHeight = 46 + prompt.length * 39;
        context.fillStyle = '#f5eee9';
        roundedRect(context, x + 40, cursorY, width - 80, promptHeight, 22);
        context.fill();
        context.fillStyle = '#a07565';
        context.font = '700 21px "Microsoft YaHei", "PingFang SC", sans-serif';
        context.fillText('当时你说', x + 64, cursorY + 31);
        context.font = '25px "Microsoft YaHei", "PingFang SC", sans-serif';
        drawLines(context, prompt, x + 64, cursorY + 70, 39, '#66534c');
        cursorY += promptHeight + 34;
    }

    context.font = '34px "Microsoft YaHei", "PingFang SC", sans-serif';
    drawLines(context, reply, x + 40, cursorY + 34, 53, '#382b28');
    cursorY += reply.length * 53 + 48;

    if (tags) {
        context.fillStyle = '#b1715b';
        context.font = '700 23px "Microsoft YaHei", "PingFang SC", sans-serif';
        context.fillText(`# ${tags}`, x + 40, cursorY + 20);
        cursorY += 58;
    }

    if (note.length) {
        context.fillStyle = '#e8d7ce';
        context.fillRect(x + 40, cursorY, 4, note.length * 39 + 25);
        context.fillStyle = '#8c7168';
        context.font = '700 21px "Microsoft YaHei", "PingFang SC", sans-serif';
        context.fillText('收藏备注', x + 62, cursorY + 20);
        context.font = '25px "Microsoft YaHei", "PingFang SC", sans-serif';
        drawLines(context, note, x + 62, cursorY + 59, 39, '#66534c');
    }

    context.fillStyle = '#c6a99d';
    context.font = '20px Georgia, serif';
    context.textAlign = 'right';
    context.fillText('REPLY KEEPSAKE  ✦', x + width - 40, y + height - 36);
    context.textAlign = 'left';
}

async function canvasToBlob(canvas) {
    return await new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Canvas export failed')), 'image/png');
    });
}

async function exportImages(items, baseName) {
    if (!items.length) {
        toastr.info('当前没有可导出的收藏');
        return;
    }

    const measureCanvas = document.createElement('canvas');
    const measureContext = measureCanvas.getContext('2d');
    const layouts = items
        .map(item => buildImageLayout(item, measureContext))
        .flatMap(layout => splitOversizedLayout(layout, measureContext));
    const pages = [];
    let page = [];
    let pageHeight = 150;

    for (const layout of layouts) {
        if (page.length && pageHeight + layout.height + 36 > MAX_CANVAS_HEIGHT) {
            pages.push({ layouts: page, height: pageHeight + 60 });
            page = [];
            pageHeight = 150;
        }
        page.push(layout);
        pageHeight += layout.height + 36;
    }
    if (page.length) pages.push({ layouts: page, height: pageHeight + 60 });

    const avatars = new Map();
    for (const item of items) {
        if (!avatars.has(item.avatar)) avatars.set(item.avatar, await loadImage(item.avatar));
    }

    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const canvas = document.createElement('canvas');
        canvas.width = IMAGE_WIDTH;
        canvas.height = pages[pageIndex].height;
        const context = canvas.getContext('2d');
        const gradient = context.createLinearGradient(0, 0, IMAGE_WIDTH, canvas.height);
        gradient.addColorStop(0, '#f4e8e0');
        gradient.addColorStop(1, '#e9ddd5');
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#5b4038';
        context.font = '700 38px "Microsoft YaHei", "PingFang SC", sans-serif';
        context.fillText('回复珍藏馆', 48, 68);
        context.fillStyle = '#9a7d72';
        context.font = '21px "Microsoft YaHei", "PingFang SC", sans-serif';
        context.fillText(`那些值得再读一遍的瞬间  ·  ${formatDate(new Date().toISOString())}`, 48, 105);

        let y = 132;
        for (const layout of pages[pageIndex].layouts) {
            drawFavoriteCard(context, layout, y, avatars.get(layout.item.avatar));
            y += layout.height + 36;
        }

        const suffix = pages.length > 1 ? `-${pageIndex + 1}of${pages.length}` : '';
        const blob = await canvasToBlob(canvas);
        downloadBlob(blob, `${safeFilename(baseName)}${suffix}-${dateStamp()}.png`);
        if (pages.length > 1) await new Promise(resolve => setTimeout(resolve, 250));
    }
}

function exportJsonBackup() {
    const backup = {
        format: 'sillytavern-reply-favorites',
        version: 2,
        exportedAt: new Date().toISOString(),
        settings: structuredClone(getSettings()),
    };
    downloadBlob(
        new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' }),
        `回复珍藏馆-备份-${dateStamp()}.json`,
    );
}

function parseBackup(text) {
    const backup = JSON.parse(text);
    if (backup?.format !== 'sillytavern-reply-favorites' || !Array.isArray(backup?.settings?.items)) {
        throw new Error('这不是有效的回复珍藏馆备份');
    }
    const settings = backup.settings;
    return {
        version: 2,
        items: settings.items.map(item => normalizeItem(structuredClone(item))),
        collections: Array.isArray(settings.collections) ? settings.collections.map(cleanText).filter(Boolean) : [],
        sort: settings.sort,
        defaultCapture: settings.defaultCapture,
    };
}

async function importJsonFile(file, mode) {
    if (!file) return;
    try {
        const incoming = parseBackup(await file.text());
        if (mode === 'replace') {
            const confirmed = await Popup.show.confirm(
                '覆盖恢复收藏',
                `将用备份中的 ${incoming.items.length} 条收藏替换当前全部数据。此操作无法自动撤销，是否继续？`,
            );
            if (!confirmed) return;
            extension_settings[EXTENSION_KEY] = incoming;
            selectedIds.clear();
            toastr.success(`已恢复 ${incoming.items.length} 条收藏`);
        } else {
            const settings = getSettings();
            const knownIds = new Set(settings.items.map(item => item.id));
            const knownKeys = new Set(settings.items.map(duplicateKey));
            const additions = [];
            for (const item of incoming.items) {
                const key = duplicateKey(item);
                if (knownIds.has(item.id) || knownKeys.has(key)) continue;
                additions.push(item);
                knownIds.add(item.id);
                knownKeys.add(key);
            }
            settings.items.push(...additions);
            settings.collections = [...new Set([...settings.collections, ...incoming.collections, ...additions.flatMap(item => item.collections || [])])];
            toastr.success(`新增 ${additions.length} 条，跳过 ${incoming.items.length - additions.length} 条重复收藏`);
        }
        saveFavorites();
        renderGallery();
        enhanceMessages();
    } catch (error) {
        console.error('[reply-favorites] Import failed', error);
        toastr.error(error.message || '无法读取备份文件', '导入失败');
    } finally {
        $('#rf-import-file').val('');
    }
}

async function deleteSelected() {
    const ids = [...selectedIds];
    if (!ids.length) {
        toastr.info('请先勾选要删除的收藏');
        return;
    }
    if (!await Popup.show.confirm('批量删除收藏', `确定删除选中的 ${ids.length} 条收藏吗？`)) return;
    const idSet = new Set(ids);
    getSettings().items = getSettings().items.filter(item => !idSet.has(item.id));
    const context = getContext();
    for (const message of context.chat) {
        if (idSet.has(message?.extra?.[FAVORITE_ID_KEY])) delete message.extra[FAVORITE_ID_KEY];
    }
    selectedIds.clear();
    saveFavorites();
    if (context.chatId) await context.saveChat();
    enhanceMessages();
    renderGallery();
    toastr.success(`已删除 ${ids.length} 条收藏`);
}

async function removeDuplicates() {
    const settings = getSettings();
    const keptByKey = new Map();
    const duplicateIds = new Set();
    const replacements = new Map();
    settings.items = settings.items.filter(item => {
        const key = duplicateKey(item);
        if (keptByKey.has(key)) {
            duplicateIds.add(item.id);
            replacements.set(item.id, keptByKey.get(key));
            return false;
        }
        keptByKey.set(key, item.id);
        return true;
    });
    const context = getContext();
    for (const message of context.chat) {
        const favoriteId = message?.extra?.[FAVORITE_ID_KEY];
        if (!duplicateIds.has(favoriteId)) continue;
        const replacementId = replacements.get(favoriteId);
        if (replacementId) message.extra[FAVORITE_ID_KEY] = replacementId;
        else delete message.extra[FAVORITE_ID_KEY];
    }
    for (const id of duplicateIds) selectedIds.delete(id);
    saveFavorites();
    if (duplicateIds.size && context.chatId) await context.saveChat();
    enhanceMessages();
    renderGallery();
    toastr[duplicateIds.size ? 'success' : 'info'](duplicateIds.size ? `已清理 ${duplicateIds.size} 条重复收藏` : '没有发现重复收藏');
}

function revisitRandom() {
    if (!filteredItems.length) {
        toastr.info('当前筛选结果为空');
        return;
    }
    const item = filteredItems[Math.floor(Math.random() * filteredItems.length)];
    const card = document.querySelector(`.rf-card[data-favorite-id="${CSS.escape(item.id)}"]`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card?.classList.add('rf-random-highlight');
    setTimeout(() => card?.classList.remove('rf-random-highlight'), 2200);
}

async function jumpToFavorite(item) {
    const context = getContext();
    closeGallery();

    try {
        if (item.source?.groupId) {
            const group = context.groups.find(entry => String(entry.id) === String(item.source.groupId));
            if (!group) throw new Error('找不到原群聊');
            if (String(context.groupId) !== String(group.id)) await openGroupById(group.id);
            if (item.source.chatId && group.chat_id !== item.source.chatId) {
                await openGroupChat(group.id, item.source.chatId);
            }
        } else {
            const characterIndex = context.characters.findIndex(character =>
                character.avatar === item.source?.characterAvatar
                || (!item.source?.characterAvatar && character.name === item.source?.characterName));
            if (characterIndex < 0) throw new Error('找不到原角色');
            if (String(context.characterId) !== String(characterIndex)) await selectCharacterById(characterIndex, { switchMenu: false });
            if (item.source?.chatId && getContext().chatId !== item.source.chatId) {
                await openCharacterChat(item.source.chatId);
            }
        }

        const refreshed = getContext();
        let messageIndex = refreshed.chat.findIndex(message => message?.extra?.[FAVORITE_ID_KEY] === item.id);
        if (messageIndex < 0) messageIndex = Number(item.source?.messageIndex);
        const target = $(`#chat .mes[mesid="${messageIndex}"]`);
        if (!target.length) throw new Error('原楼层已经不存在，但收藏快照仍然保留');
        target[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.addClass('rf-jump-highlight');
        setTimeout(() => target.removeClass('rf-jump-highlight'), 2200);
    } catch (error) {
        toastr.warning(error.message, '无法定位原楼层');
    }
}

function bindEvents() {
    $(document)
        .on('click', '.rf-message-favorite', async function (event) {
            event.stopPropagation();
            await toggleFavorite(Number($(this).closest('.mes').attr('mesid')), $(this), event.shiftKey);
        })
        .on('click', '#rf-open-fab, #rf-open-settings', openGallery)
        .on('click', '#rf-close', closeGallery)
        .on('click', '#rf-overlay', function (event) {
            if (event.target === this) closeGallery();
        })
        .on('input', '#rf-search-input', renderGallery)
        .on('change', '#rf-character-filter, #rf-collection-filter', renderGallery)
        .on('change', '#rf-sort', function () {
            getSettings().sort = String($(this).val());
            saveFavorites();
            renderGallery();
        })
        .on('change', '#rf-default-capture', function () {
            getSettings().defaultCapture = String($(this).val());
            saveFavorites();
        })
        .on('change', '#rf-select-all', function () {
            for (const item of filteredItems) {
                this.checked ? selectedIds.add(item.id) : selectedIds.delete(item.id);
            }
            renderGallery();
        })
        .on('change', '.rf-card-check input', function () {
            const id = $(this).closest('.rf-card').data('favorite-id');
            this.checked ? selectedIds.add(id) : selectedIds.delete(id);
            renderGallery();
        })
        .on('input', '.rf-title, .rf-collections, .rf-tags, .rf-note', function () {
            const card = $(this).closest('.rf-card');
            const item = getSettings().items.find(entry => entry.id === card.data('favorite-id'));
            if (!item) return;
            if ($(this).hasClass('rf-tags')) {
                item.tags = String($(this).val()).split(/[,，]/).map(tag => tag.trim()).filter(Boolean);
            } else if ($(this).hasClass('rf-collections')) {
                item.collections = [...new Set(String($(this).val()).split(/[,，]/).map(name => name.trim()).filter(Boolean))];
                getSettings().collections = [...new Set([...getSettings().collections, ...item.collections])];
            } else if ($(this).hasClass('rf-title')) {
                item.title = cleanText($(this).val());
                card.find('.rf-card-identity strong').text(item.title || item.characterName);
            } else {
                item.note = cleanText($(this).val());
            }
            saveFavorites();
        })
        .on('change', '.rf-title, .rf-collections, .rf-tags, .rf-note', function () {
            renderGallery();
            toastr.success('已保存', '', { timeOut: 900 });
        })
        .on('click', '.rf-remove', async function () {
            await removeFavorite($(this).closest('.rf-card').data('favorite-id'), true);
        })
        .on('click', '.rf-jump', async function () {
            const item = getSettings().items.find(entry => entry.id === $(this).closest('.rf-card').data('favorite-id'));
            if (item) await jumpToFavorite(item);
        })
        .on('click', '.rf-card-image', async function () {
            const item = getSettings().items.find(entry => entry.id === $(this).closest('.rf-card').data('favorite-id'));
            if (!item) return;
            await exportImages([item], `${item.characterName}-回复珍藏`);
        })
        .on('click', '#rf-export-md', exportMarkdown)
        .on('click', '#rf-export-json', exportJsonBackup)
        .on('click', '.rf-import-json', function () {
            $('#rf-import-file').data('mode', $(this).data('mode')).trigger('click');
        })
        .on('change', '#rf-import-file', async function () {
            await importJsonFile(this.files?.[0], $(this).data('mode') || 'merge');
        })
        .on('click', '#rf-delete-selected', deleteSelected)
        .on('click', '#rf-dedupe', removeDuplicates)
        .on('click', '#rf-random', revisitRandom)
        .on('click', '#rf-export-image', async () => {
            await exportImages(getExportItems(), '回复珍藏馆');
        })
        .on('keydown', function (event) {
            if (event.key === 'Escape' && $('#rf-overlay').hasClass('rf-open')) closeGallery();
        });
}

function initialize() {
    getSettings();
    document.documentElement.insertAdjacentHTML('beforeend', galleryMarkup());
    $('#extensions_settings2').append(settingsMarkup());
    bindEvents();
    $('#rf-default-capture').val(getSettings().defaultCapture);
    enhanceMessages();

    [
        event_types.CHAT_CHANGED,
        event_types.CHAT_LOADED,
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_SWIPED,
        event_types.MORE_MESSAGES_LOADED,
    ].forEach(eventName => eventSource.on(eventName, () => setTimeout(enhanceMessages, 0)));
}

jQuery(initialize);
