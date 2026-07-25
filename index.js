import { extension_settings } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    openCharacterChat,
    messageFormatting,
    saveSettingsDebounced,
    selectCharacterById,
} from '../../../../script.js';
import { openGroupById, openGroupChat } from '../../../group-chats.js';
import { Popup } from '../../../popup.js';
import { escapeHtml } from '../../../utils.js';

const EXTENSION_KEY = 'replyFavorites';
const FAVORITE_ID_KEY = 'reply_favorite_id';
const IMAGE_EXPORT_LOCK_KEY = '__replyFavoritesImageExportTask';
const EVENT_HANDLERS_KEY = '__replyFavoritesEventHandlers';
const MAX_CANVAS_HEIGHT = 15000;
const IMAGE_WIDTH = 1200;
const settingsDefaults = Object.freeze({
    version: 3,
    items: [],
    collections: [],
    sort: 'newest',
    defaultCapture: 'previous-user',
    imageTheme: 'warm',
    imageRenderMode: 'card',
    imageBackground: 'theme',
    imageBackgroundColor: '#f4e8e0',
    imageTitle: '回复珍藏馆',
    imageSubtitle: '那些值得再读一遍的瞬间',
    imageShowDate: true,
});
const imageThemes = Object.freeze({
    warm: {
        background: ['#f4e8e0', '#e9ddd5'],
        card: '#fffdf9',
        ink: '#382b28',
        muted: '#9a8178',
        soft: '#f5eee9',
        softInk: '#66534c',
        accent: '#b1715b',
        line: '#e8d7ce',
        mark: '#d7b7a9',
    },
    night: {
        background: ['#161925', '#2b2235'],
        card: '#252a38',
        ink: '#f8f1ea',
        muted: '#b8afbd',
        soft: '#323747',
        softInk: '#e3dce5',
        accent: '#d9a27f',
        line: '#5b5265',
        mark: '#765e78',
    },
    forest: {
        background: ['#dfe9e0', '#c8d7cd'],
        card: '#f8fbf5',
        ink: '#26352e',
        muted: '#708078',
        soft: '#e8f0e8',
        softInk: '#41564b',
        accent: '#557866',
        line: '#bdd0c3',
        mark: '#9eb7a6',
    },
    ink: {
        background: ['#e8e5df', '#cbc7be'],
        card: '#f8f6f1',
        ink: '#202020',
        muted: '#6f6d68',
        soft: '#ece9e2',
        softInk: '#3f3e3b',
        accent: '#55514b',
        line: '#c9c4bb',
        mark: '#a8a39a',
    },
});

let filteredItems = [];
const selectedIds = new Set();
let htmlToImageLoader;

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
    settings.imageTheme = Object.hasOwn(imageThemes, settings.imageTheme) ? settings.imageTheme : 'warm';
    settings.imageRenderMode = ['card', 'tavern'].includes(settings.imageRenderMode) ? settings.imageRenderMode : 'card';
    settings.imageBackground = ['theme', 'cream', 'night', 'sage', 'custom'].includes(settings.imageBackground)
        ? settings.imageBackground
        : 'theme';
    settings.imageBackgroundColor = /^#[0-9a-f]{6}$/i.test(settings.imageBackgroundColor) ? settings.imageBackgroundColor : '#f4e8e0';
    settings.imageTitle = typeof settings.imageTitle === 'string' ? cleanText(settings.imageTitle).slice(0, 60) : '回复珍藏馆';
    settings.imageSubtitle = typeof settings.imageSubtitle === 'string' ? cleanText(settings.imageSubtitle).slice(0, 100) : '那些值得再读一遍的瞬间';
    settings.imageShowDate = settings.imageShowDate !== false;
    settings.version = 3;
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
            renderedHtml: typeof message?.renderedHtml === 'string' ? message.renderedHtml : '',
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
        renderedHtml: captureRenderedMessageHtml(index),
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
                <fieldset class="rf-image-settings">
                    <legend>图片导出样式</legend>
                    <div class="rf-image-settings-grid">
                        <label class="rf-render-mode-field">图片内容样式
                            <select id="rf-image-render-mode">
                                <option value="card">珍藏卡片（稳定）</option>
                                <option value="tavern">跟随当前酒馆楼层美化（实验）</option>
                            </select>
                            <small>酒馆模式会复制当前消息楼层及其 CSS；无法复刻时自动回退到珍藏卡片。</small>
                        </label>
                        <label>图片主题
                            <select id="rf-image-theme">
                                <option value="warm">暖茶</option>
                                <option value="night">夜幕</option>
                                <option value="forest">森野</option>
                                <option value="ink">素墨</option>
                            </select>
                        </label>
                        <label>画布背景
                            <select id="rf-image-background">
                                <option value="theme">跟随主题</option>
                                <option value="cream">奶油纸</option>
                                <option value="night">深夜蓝</option>
                                <option value="sage">鼠尾草</option>
                                <option value="custom">自定义颜色</option>
                            </select>
                        </label>
                        <label class="rf-custom-background">自定义背景色
                            <span><input id="rf-image-background-color" type="color"><code id="rf-image-background-value"></code></span>
                        </label>
                        <label>图片主标题
                            <input id="rf-image-title" maxlength="60" placeholder="回复珍藏馆">
                        </label>
                        <label class="rf-image-subtitle-field">图片副标题
                            <input id="rf-image-subtitle" maxlength="100" placeholder="那些值得再读一遍的瞬间">
                        </label>
                        <label class="rf-image-show-date"><input id="rf-image-show-date" type="checkbox"> 在副标题后显示导出日期</label>
                    </div>
                    <div id="rf-image-theme-preview" aria-label="图片主题预览">
                        <b class="rf-preview-mode-badge"></b>
                        <span class="rf-preview-title"></span>
                        <small class="rf-preview-subtitle"></small>
                        <i></i>
                    </div>
                </fieldset>
                <button id="rf-open-settings" class="menu_button"><i class="fa-solid fa-star"></i> 打开珍藏馆</button>
            </div>
        </div>`;
}

function getImageStyle() {
    return imageThemes[getSettings().imageTheme] || imageThemes.warm;
}

function getImageBackground() {
    const settings = getSettings();
    if (settings.imageBackground === 'cream') return ['#f7eee7', '#e8ded6'];
    if (settings.imageBackground === 'night') return ['#151827', '#29243a'];
    if (settings.imageBackground === 'sage') return ['#dce8df', '#c7d7cc'];
    if (settings.imageBackground === 'custom') return [settings.imageBackgroundColor, settings.imageBackgroundColor];
    return getImageStyle().background;
}

function updateImageThemePreview() {
    const settings = getSettings();
    const theme = getImageStyle();
    const background = getImageBackground();
    $('#rf-image-background-value').text(settings.imageBackgroundColor);
    $('.rf-custom-background').toggleClass('rf-visible', settings.imageBackground === 'custom');
    $('.rf-image-settings').toggleClass('rf-tavern-mode', settings.imageRenderMode === 'tavern');
    $('#rf-image-theme-preview')
        .css({
            '--rf-preview-bg-start': background[0],
            '--rf-preview-bg-end': background[1],
            '--rf-preview-card': theme.card,
            '--rf-preview-ink': theme.ink,
            '--rf-preview-muted': theme.muted,
            '--rf-preview-accent': theme.accent,
        })
        .find('.rf-preview-mode-badge').text(settings.imageRenderMode === 'tavern' ? '酒馆楼层' : '珍藏卡片').end()
        .find('.rf-preview-title').text(settings.imageTitle || '（无主标题）').end()
        .find('.rf-preview-subtitle').text(settings.imageSubtitle || '（无副标题）');
}

function updateImageSettingsUi() {
    const settings = getSettings();
    $('#rf-image-render-mode').val(settings.imageRenderMode);
    $('#rf-image-theme').val(settings.imageTheme);
    $('#rf-image-background').val(settings.imageBackground);
    $('#rf-image-background-color').val(settings.imageBackgroundColor);
    $('#rf-image-title').val(settings.imageTitle);
    $('#rf-image-subtitle').val(settings.imageSubtitle);
    $('#rf-image-show-date').prop('checked', settings.imageShowDate);
    updateImageThemePreview();
}

function saveImagePreferences() {
    const settings = getSettings();
    settings.imageRenderMode = String($('#rf-image-render-mode').val() || 'card');
    settings.imageTheme = String($('#rf-image-theme').val() || 'warm');
    settings.imageBackground = String($('#rf-image-background').val() || 'theme');
    settings.imageBackgroundColor = String($('#rf-image-background-color').val() || '#f4e8e0');
    settings.imageTitle = cleanText($('#rf-image-title').val()).slice(0, 60);
    settings.imageSubtitle = cleanText($('#rf-image-subtitle').val()).slice(0, 100);
    settings.imageShowDate = $('#rf-image-show-date').prop('checked');
    saveFavorites();
    updateImageThemePreview();
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
    const formatMessage = message => {
        try {
            return messageFormatting(
                message.text,
                message.name,
                false,
                Boolean(message.isUser),
                Number(message.messageIndex),
            );
        } catch (error) {
            console.warn('[reply-favorites] Could not apply Tavern message formatting.', error);
            return escapeHtml(message.text).replace(/\n/g, '<br>');
        }
    };
    const snapshotMarkup = message => {
        const snapshot = parseRenderedMessageHtml(message.renderedHtml);
        if (!snapshot) return '';
        cleanTavernMessageClone(snapshot);
        const renderedText = snapshot.querySelector('.mes_text');
        if (!renderedText) return '';
        return `<div class="rf-message rf-formatted-message rf-rendered-snapshot">${renderedText.innerHTML}</div>`;
    };
    if (messages.length <= 1) {
        const message = messages[0] || {
            text: item.text,
            name: item.characterName,
            isUser: false,
            messageIndex: item.source?.messageIndex || 0,
        };
        return snapshotMarkup(message)
            || `<div class="rf-message rf-formatted-message">${formatMessage(message)}</div>`;
    }
    return `<div class="rf-captured">${messages.map(message => `
        <div class="rf-captured-message ${message.isUser ? 'rf-user' : 'rf-character'}">
            ${snapshotMarkup(message) || `
                <span>${escapeHtml(message.name)} · 第 ${Number(message.messageIndex) + 1} 层</span>
                <div class="rf-formatted-message">${formatMessage(message)}</div>`}
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
    syncFavoriteRenderedSnapshots();
    renderGallery();
    setTimeout(() => $('#rf-search-input').trigger('focus'), 50);
}

function closeGallery() {
    $('.rf-data-menu').prop('open', false);
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

function drawFavoriteCard(context, layout, y, avatar, theme) {
    const { item, reply, prompt, note, tags, height } = layout;
    const x = 48;
    const width = IMAGE_WIDTH - 96;

    context.save();
    context.shadowColor = 'rgba(77, 52, 42, .10)';
    context.shadowBlur = 24;
    context.shadowOffsetY = 8;
    context.fillStyle = theme.card;
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
        context.fillStyle = theme.mark;
        roundedRect(context, x + 40, y + 38, 76, 76, 24);
        context.fill();
        context.fillStyle = theme.card;
        context.font = '700 34px serif';
        context.textAlign = 'center';
        context.fillText('✦', x + 78, y + 89);
        context.textAlign = 'left';
    }

    context.fillStyle = theme.ink;
    context.font = '700 34px "Microsoft YaHei", "PingFang SC", sans-serif';
    context.fillText(item.title || item.characterName, x + 140, y + 72);
    context.fillStyle = theme.muted;
    context.font = '23px "Microsoft YaHei", "PingFang SC", sans-serif';
    const imageMeta = item.title ? `${item.characterName}  ·  ${formatDate(item.createdAt)}` : `${formatDate(item.createdAt)}  ·  ${item.source?.chatId || '未知聊天'}`;
    context.fillText(imageMeta, x + 140, y + 106);

    let cursorY = y + 164;
    if (prompt.length) {
        const promptHeight = 46 + prompt.length * 39;
        context.fillStyle = theme.soft;
        roundedRect(context, x + 40, cursorY, width - 80, promptHeight, 22);
        context.fill();
        context.fillStyle = theme.accent;
        context.font = '700 21px "Microsoft YaHei", "PingFang SC", sans-serif';
        context.fillText('当时你说', x + 64, cursorY + 31);
        context.font = '25px "Microsoft YaHei", "PingFang SC", sans-serif';
        drawLines(context, prompt, x + 64, cursorY + 70, 39, theme.softInk);
        cursorY += promptHeight + 34;
    }

    context.font = '34px "Microsoft YaHei", "PingFang SC", sans-serif';
    drawLines(context, reply, x + 40, cursorY + 34, 53, theme.ink);
    cursorY += reply.length * 53 + 48;

    if (tags) {
        context.fillStyle = theme.accent;
        context.font = '700 23px "Microsoft YaHei", "PingFang SC", sans-serif';
        context.fillText(`# ${tags}`, x + 40, cursorY + 20);
        cursorY += 58;
    }

    if (note.length) {
        context.fillStyle = theme.line;
        context.fillRect(x + 40, cursorY, 4, note.length * 39 + 25);
        context.fillStyle = theme.accent;
        context.font = '700 21px "Microsoft YaHei", "PingFang SC", sans-serif';
        context.fillText('收藏备注', x + 62, cursorY + 20);
        context.font = '25px "Microsoft YaHei", "PingFang SC", sans-serif';
        drawLines(context, note, x + 62, cursorY + 59, 39, theme.softInk);
    }

    context.fillStyle = theme.muted;
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

async function getHtmlToImage() {
    if (globalThis.htmlToImage?.toCanvas) return globalThis.htmlToImage;
    if (!htmlToImageLoader) {
        htmlToImageLoader = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = new URL('./vendor/html-to-image/html-to-image.js', import.meta.url).href;
            script.onload = () => globalThis.htmlToImage?.toCanvas
                ? resolve(globalThis.htmlToImage)
                : reject(new Error('楼层渲染组件未正确加载'));
            script.onerror = () => reject(new Error('无法加载楼层渲染组件'));
            document.head.append(script);
        });
    }
    return await htmlToImageLoader;
}

function cleanTavernMessageClone(clone) {
    [
        '.for_checkbox',
        '.del_checkbox',
        '.mes_buttons',
        '.mes_edit_buttons',
        '.extraMesButtons',
        '.swipe_left',
        '.swipeRightBlock',
        '.rf-message-favorite',
        '.mes_reasoning_details',
        '.mes_media_wrapper:empty',
        '.mes_file_wrapper:empty',
        'script',
    ].forEach(selector => clone.querySelectorAll(selector).forEach(element => element.remove()));
    clone.classList.remove('last_mes', 'swipes_visible', 'fade');
    clone.style.height = 'auto';
    clone.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    clone.querySelectorAll('[contenteditable]').forEach(element => element.removeAttribute('contenteditable'));
    clone.querySelectorAll('[tabindex]').forEach(element => element.removeAttribute('tabindex'));
    return clone;
}

function parseRenderedMessageHtml(html) {
    if (!html) return null;
    const template = document.createElement('template');
    template.innerHTML = String(html).trim();
    const message = template.content.querySelector('.mes');
    return message instanceof HTMLElement ? message : null;
}

function getLiveMessageNode(messageIndex) {
    return document.querySelector(`#chat .mes[mesid="${CSS.escape(String(messageIndex))}"]`);
}

function captureRenderedMessageHtml(messageIndex) {
    const liveNode = getLiveMessageNode(messageIndex);
    if (!liveNode) return '';
    return cleanTavernMessageClone(liveNode.cloneNode(true)).outerHTML;
}

function syncFavoriteRenderedSnapshots(messageIndexes = null) {
    const context = getContext();
    if (!context.chatId) return false;
    const requestedIndexes = Array.isArray(messageIndexes)
        ? new Set(messageIndexes.map(Number).filter(Number.isFinite))
        : null;
    let changed = false;

    for (const item of getSettings().items) {
        if (String(item.source?.chatId || '') !== String(context.chatId)) continue;
        for (const message of item.messages || []) {
            const messageIndex = Number(message.messageIndex);
            if (requestedIndexes && !requestedIndexes.has(messageIndex)) continue;
            if (cleanText(context.chat?.[messageIndex]?.mes) !== cleanText(message.text)) continue;
            const renderedHtml = captureRenderedMessageHtml(messageIndex);
            if (renderedHtml && renderedHtml !== message.renderedHtml) {
                message.renderedHtml = renderedHtml;
                changed = true;
            }
        }
    }

    if (changed) {
        saveFavorites();
        if ($('#rf-overlay').hasClass('rf-open')) renderGallery();
    }
    return changed;
}

function scheduleFavoriteSnapshotSync(messageIndex) {
    const indexes = Number.isFinite(Number(messageIndex)) ? [Number(messageIndex)] : null;
    setTimeout(() => syncFavoriteRenderedSnapshots(indexes), 450);
    setTimeout(() => syncFavoriteRenderedSnapshots(indexes), 1400);
}

function getTavernMessageClone(item, message) {
    const context = getContext();
    const sourceIsCurrent = String(context.chatId || '') === String(item.source?.chatId || '');
    const selector = `#chat .mes[mesid="${CSS.escape(String(message.messageIndex))}"]`;
    const liveNode = sourceIsCurrent ? document.querySelector(selector) : null;
    const currentMessage = sourceIsCurrent ? context.chat?.[message.messageIndex] : null;
    const canReuseLiveContent = liveNode && cleanText(currentMessage?.mes) === cleanText(message.text);
    const storedNode = parseRenderedMessageHtml(message.renderedHtml);
    const matchingTemplate = document.querySelector(`#chat .mes[is_user="${message.isUser ? 'true' : 'false'}"]`);
    const template = (canReuseLiveContent ? liveNode : storedNode)
        || liveNode
        || matchingTemplate
        || document.querySelector('#chat .mes');
    if (!template) throw new Error('当前页面没有可用于复刻美化的消息楼层');

    const clone = cleanTavernMessageClone(template.cloneNode(true));
    clone.setAttribute('mesid', String(message.messageIndex));
    clone.setAttribute('ch_name', message.name);
    clone.setAttribute('is_user', String(message.isUser));
    clone.setAttribute('is_system', 'false');

    if (!canReuseLiveContent && !storedNode) {
        const textElement = clone.querySelector('.mes_text');
        if (!textElement) throw new Error('消息楼层缺少正文区域');
        textElement.innerHTML = messageFormatting(
            message.text,
            message.name,
            false,
            message.isUser,
            message.messageIndex,
        );
    }

    const nameElement = clone.querySelector('.name_text');
    if (nameElement) nameElement.textContent = message.name;
    const avatar = clone.querySelector('.avatar img');
    if (avatar && !message.isUser && item.avatar) {
        avatar.src = item.avatar;
        avatar.removeAttribute('srcset');
    }
    return clone;
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error || new Error('无法读取装饰素材'));
        reader.readAsDataURL(blob);
    });
}

async function getEmbeddedResourceUrl(url, cache) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url;
    let resolvedUrl;
    try {
        resolvedUrl = new URL(url, document.baseURI).href;
    } catch {
        return url;
    }
    if (!cache.has(resolvedUrl)) {
        cache.set(resolvedUrl, (async () => {
            const isSameOrigin = new URL(resolvedUrl).origin === location.origin;
            const response = await fetch(resolvedUrl, {
                mode: 'cors',
                credentials: isSameOrigin ? 'same-origin' : 'omit',
                cache: 'force-cache',
            });
            if (!response.ok) throw new Error(`装饰素材加载失败（${response.status}）`);
            return await blobToDataUrl(await response.blob());
        })());
    }
    try {
        return await cache.get(resolvedUrl);
    } catch (error) {
        console.warn('[reply-favorites] Could not embed decorative resource.', resolvedUrl, error);
        return url;
    }
}

async function embedCssUrls(value, cache) {
    if (!value || value === 'none' || !value.includes('url(')) return value;
    const matches = [...value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)];
    let embeddedValue = value;
    for (const match of matches) {
        if (!match[2]) continue;
        const embeddedUrl = await getEmbeddedResourceUrl(match[2], cache);
        embeddedValue = embeddedValue.replace(match[0], `url("${embeddedUrl.replaceAll('"', '\\"')}")`);
    }
    return embeddedValue;
}

async function inlineTavernResources(stage, cache) {
    const resourceProperties = [
        ['background-image', 'backgroundImage'],
        ['mask-image', 'maskImage'],
        ['-webkit-mask-image', 'webkitMaskImage'],
        ['border-image-source', 'borderImageSource'],
        ['list-style-image', 'listStyleImage'],
    ];
    const pseudoRules = [];
    const elements = [stage, ...stage.querySelectorAll('*')];
    let resourceId = 0;

    for (const element of elements) {
        if (element instanceof HTMLImageElement && element.currentSrc) {
            element.src = await getEmbeddedResourceUrl(element.currentSrc, cache);
            element.removeAttribute('srcset');
        }
        const style = getComputedStyle(element);
        for (const [cssProperty, jsProperty] of resourceProperties) {
            const value = style[jsProperty];
            if (value?.includes('url(')) {
                element.style.setProperty(cssProperty, await embedCssUrls(value, cache), 'important');
            }
        }

        for (const pseudo of ['::before', '::after']) {
            const pseudoStyle = getComputedStyle(element, pseudo);
            const embeddedResources = new Map();
            for (const [cssProperty, jsProperty] of resourceProperties) {
                const value = pseudoStyle[jsProperty];
                if (value?.includes('url(')) {
                    embeddedResources.set(cssProperty, await embedCssUrls(value, cache));
                }
            }
            if (embeddedResources.size) {
                const id = `r${resourceId++}`;
                element.dataset.rfResourceId = id;
                pseudoRules.push(`[data-rf-resource-id="${id}"]${pseudo} { content: none !important; }`);

                const layer = document.createElement('span');
                layer.className = 'rf-materialized-pseudo';
                layer.dataset.rfPseudo = pseudo.slice(2);
                layer.setAttribute('aria-hidden', 'true');
                for (const property of pseudoStyle) {
                    layer.style.setProperty(
                        property,
                        pseudoStyle.getPropertyValue(property),
                        pseudoStyle.getPropertyPriority(property),
                    );
                }
                for (const [property, value] of embeddedResources) {
                    layer.style.setProperty(property, value, 'important');
                }
                layer.style.setProperty('content', 'normal', 'important');
                layer.style.setProperty('pointer-events', 'none', 'important');
                element.style.setProperty('isolation', 'isolate');
                pseudo === '::before' ? element.prepend(layer) : element.append(layer);
            }
        }
    }

    if (pseudoRules.length) {
        const style = document.createElement('style');
        style.dataset.rfEmbeddedResources = '';
        style.textContent = pseudoRules.join('\n');
        stage.prepend(style);
    }
}

async function renderTavernItemCanvas(item, resourceCache, constrainHeight = false) {
    const htmlToImage = await getHtmlToImage();
    const chatRoot = document.querySelector('#chat');
    if (!chatRoot) throw new Error('当前页面没有聊天区域');
    const chatWidth = Math.ceil(chatRoot.getBoundingClientRect().width || 900);
    const stage = document.createElement('div');
    stage.className = 'rf-tavern-export-stage';
    stage.style.width = `${Math.min(1200, Math.max(640, chatWidth))}px`;
    stage.dataset.favoriteId = item.id;

    for (const message of item.messages || []) {
        stage.append(getTavernMessageClone(item, message));
    }
    if (!stage.children.length) throw new Error('收藏中没有可渲染的消息');

    chatRoot.append(stage);
    try {
        await inlineTavernResources(stage, resourceCache);
        await Promise.race([
            document.fonts?.ready || Promise.resolve(),
            new Promise(resolve => setTimeout(resolve, 1800)),
        ]);
        const basePixelRatio = Math.min(2, Math.max(1.25, globalThis.devicePixelRatio || 1));
        const stageHeight = Math.max(1, Math.ceil(stage.getBoundingClientRect().height || stage.scrollHeight || 1));
        const pixelRatio = constrainHeight
            ? Math.min(basePixelRatio, Math.max(0.35, (MAX_CANVAS_HEIGHT - 320) / stageHeight))
            : basePixelRatio;
        const canvas = await htmlToImage.toCanvas(stage, {
            cacheBust: true,
            pixelRatio,
            backgroundColor: 'transparent',
            imagePlaceholder: 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=',
            style: {
                position: 'static',
                top: 'auto',
                left: 'auto',
                zIndex: 'auto',
                pointerEvents: 'none',
            },
            filter: node => !(node instanceof Element) || !node.matches('audio, video, iframe'),
        });
        if (!canvas.width || !canvas.height) throw new Error('生成的楼层图片尺寸无效');
        return canvas;
    } finally {
        stage.remove();
    }
}

function splitTavernCanvas(canvas) {
    const targetWidth = IMAGE_WIDTH - 96;
    const maxTargetHeight = MAX_CANVAS_HEIGHT - 260;
    const maxSourceHeight = Math.max(1, Math.floor(maxTargetHeight * canvas.width / targetWidth));
    if (canvas.height <= maxSourceHeight) return [canvas];

    const parts = [];
    for (let sourceY = 0; sourceY < canvas.height; sourceY += maxSourceHeight) {
        const sourceHeight = Math.min(maxSourceHeight, canvas.height - sourceY);
        const part = document.createElement('canvas');
        part.width = canvas.width;
        part.height = sourceHeight;
        part.getContext('2d').drawImage(canvas, 0, sourceY, canvas.width, sourceHeight, 0, 0, canvas.width, sourceHeight);
        parts.push(part);
    }
    return parts;
}

function paintExportBackground(context, height, background) {
    const gradient = context.createLinearGradient(0, 0, IMAGE_WIDTH, height);
    gradient.addColorStop(0, background[0]);
    gradient.addColorStop(1, background[1]);
    context.fillStyle = gradient;
    context.fillRect(0, 0, IMAGE_WIDTH, height);
}

function drawExportHeader(context, settings, theme) {
    if (settings.imageTitle) {
        context.fillStyle = theme.ink;
        context.font = '700 38px "Microsoft YaHei", "PingFang SC", sans-serif';
        context.fillText(settings.imageTitle, 48, 68, IMAGE_WIDTH - 96);
    }
    const subtitleParts = [settings.imageSubtitle, settings.imageShowDate ? formatDate(new Date().toISOString()) : ''].filter(Boolean);
    if (subtitleParts.length) {
        context.fillStyle = theme.muted;
        context.font = '21px "Microsoft YaHei", "PingFang SC", sans-serif';
        context.fillText(subtitleParts.join('  ·  '), 48, 105, IMAGE_WIDTH - 96);
    }
}

async function exportTavernImages(items, baseName) {
    const rendered = [];
    const resourceCache = new Map();
    const singleItem = items.length === 1;
    for (let index = 0; index < items.length; index++) {
        toastr.info(`正在内嵌装饰并复刻酒馆楼层 ${index + 1}/${items.length}…`, '', { timeOut: 1200 });
        const canvas = await renderTavernItemCanvas(items[index], resourceCache, singleItem);
        rendered.push(...(singleItem ? [canvas] : splitTavernCanvas(canvas)));
    }

    const entries = rendered.map(canvas => {
        const targetWidth = IMAGE_WIDTH - 96;
        const naturalHeight = Math.ceil(canvas.height * targetWidth / canvas.width);
        const scale = singleItem && naturalHeight > MAX_CANVAS_HEIGHT - 260
            ? (MAX_CANVAS_HEIGHT - 260) / naturalHeight
            : 1;
        return {
            canvas,
            width: Math.floor(targetWidth * scale),
            height: Math.floor(naturalHeight * scale),
        };
    });
    const pages = [];
    let page = [];
    let pageHeight = 150;
    for (const entry of entries) {
        if (page.length && pageHeight + entry.height + 36 > MAX_CANVAS_HEIGHT) {
            pages.push({ entries: page, height: pageHeight + 60 });
            page = [];
            pageHeight = 150;
        }
        page.push(entry);
        pageHeight += entry.height + 36;
    }
    if (page.length) pages.push({ entries: page, height: pageHeight + 60 });

    const settings = getSettings();
    const theme = getImageStyle();
    const background = getImageBackground();
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const canvas = document.createElement('canvas');
        canvas.width = IMAGE_WIDTH;
        canvas.height = pages[pageIndex].height;
        const context = canvas.getContext('2d');
        paintExportBackground(context, canvas.height, background);
        drawExportHeader(context, settings, theme);
        let y = 132;
        for (const entry of pages[pageIndex].entries) {
            context.drawImage(entry.canvas, Math.round((IMAGE_WIDTH - entry.width) / 2), y, entry.width, entry.height);
            y += entry.height + 36;
        }
        const suffix = pages.length > 1 ? `-${pageIndex + 1}of${pages.length}` : '';
        downloadBlob(await canvasToBlob(canvas), `${safeFilename(baseName)}-酒馆楼层${suffix}-${dateStamp()}.png`);
        if (pages.length > 1) await new Promise(resolve => setTimeout(resolve, 250));
    }
}

async function exportCardImages(items, baseName) {
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

    const settings = getSettings();
    const theme = getImageStyle();
    const background = getImageBackground();
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
        const canvas = document.createElement('canvas');
        canvas.width = IMAGE_WIDTH;
        canvas.height = pages[pageIndex].height;
        const context = canvas.getContext('2d');
        paintExportBackground(context, canvas.height, background);
        drawExportHeader(context, settings, theme);

        let y = 132;
        for (const layout of pages[pageIndex].layouts) {
            drawFavoriteCard(context, layout, y, avatars.get(layout.item.avatar), theme);
            y += layout.height + 36;
        }

        const suffix = pages.length > 1 ? `-${pageIndex + 1}of${pages.length}` : '';
        const blob = await canvasToBlob(canvas);
        downloadBlob(blob, `${safeFilename(baseName)}${suffix}-${dateStamp()}.png`);
        if (pages.length > 1) await new Promise(resolve => setTimeout(resolve, 250));
    }
}

async function runImageExport(items, baseName) {
    if (!items.length) {
        toastr.info('当前没有可导出的收藏');
        return;
    }
    if (getSettings().imageRenderMode !== 'tavern') {
        await exportCardImages(items, baseName);
        return;
    }
    try {
        await exportTavernImages(items, baseName);
    } catch (error) {
        console.warn('[reply-favorites] Tavern-style export failed; falling back to card export.', error);
        toastr.warning(`${error.message || '无法复刻当前楼层'}，已改用珍藏卡片导出`, '酒馆美化导出回退');
        await exportCardImages(items, baseName);
    }
}

function exportImages(items, baseName) {
    const activeExport = globalThis[IMAGE_EXPORT_LOCK_KEY];
    if (activeExport) {
        toastr.info('图片正在生成，请稍候', '', { timeOut: 1000 });
        return activeExport;
    }

    const task = runImageExport(items, baseName);
    globalThis[IMAGE_EXPORT_LOCK_KEY] = task;
    $('#rf-export-image, .rf-card-image').prop('disabled', true).attr('aria-busy', 'true');
    const clearExportLock = () => {
        if (globalThis[IMAGE_EXPORT_LOCK_KEY] === task) delete globalThis[IMAGE_EXPORT_LOCK_KEY];
        $('#rf-export-image, .rf-card-image').prop('disabled', false).removeAttr('aria-busy');
    };
    task.then(clearExportLock, clearExportLock);
    return task;
}

function exportJsonBackup() {
    const backup = {
        format: 'sillytavern-reply-favorites',
        version: 3,
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
        version: 3,
        items: settings.items.map(item => normalizeItem(structuredClone(item))),
        collections: Array.isArray(settings.collections) ? settings.collections.map(cleanText).filter(Boolean) : [],
        sort: settings.sort,
        defaultCapture: settings.defaultCapture,
        imageTheme: settings.imageTheme,
        imageRenderMode: settings.imageRenderMode,
        imageBackground: settings.imageBackground,
        imageBackgroundColor: settings.imageBackgroundColor,
        imageTitle: settings.imageTitle,
        imageSubtitle: settings.imageSubtitle,
        imageShowDate: settings.imageShowDate,
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
    const documentRoot = $(document);
    documentRoot.off('.replyFavorites');
    [
        ['click', '.rf-message-favorite'],
        ['click', '#rf-open-fab, #rf-open-settings'],
        ['click', '#rf-close'],
        ['click', '#rf-overlay'],
        ['click', '.rf-data-menu > div .menu_button'],
        ['click', '.rf-remove'],
        ['click', '.rf-jump'],
        ['click', '.rf-card-image'],
        ['click', '#rf-export-md'],
        ['click', '#rf-export-json'],
        ['click', '.rf-import-json'],
        ['click', '#rf-delete-selected'],
        ['click', '#rf-dedupe'],
        ['click', '#rf-random'],
        ['click', '#rf-export-image'],
    ].forEach(([eventName, selector]) => documentRoot.off(eventName, selector));

    documentRoot
        .on('click.replyFavorites', '.rf-message-favorite', async function (event) {
            event.stopPropagation();
            await toggleFavorite(Number($(this).closest('.mes').attr('mesid')), $(this), event.shiftKey);
        })
        .on('click.replyFavorites', '#rf-open-fab, #rf-open-settings', openGallery)
        .on('click.replyFavorites', '#rf-close', closeGallery)
        .on('click.replyFavorites', '#rf-overlay', function (event) {
            if (event.target === this) closeGallery();
        })
        .on('pointerdown.replyFavorites', function (event) {
            if (!$(event.target).closest('.rf-data-menu').length) {
                $('.rf-data-menu').prop('open', false);
            }
        })
        .on('click.replyFavorites', '.rf-data-menu > div .menu_button', function () {
            $(this).closest('.rf-data-menu').prop('open', false);
        })
        .on('input.replyFavorites', '#rf-search-input', renderGallery)
        .on('change.replyFavorites', '#rf-character-filter, #rf-collection-filter', renderGallery)
        .on('change.replyFavorites', '#rf-sort', function () {
            getSettings().sort = String($(this).val());
            saveFavorites();
            renderGallery();
        })
        .on('change.replyFavorites', '#rf-default-capture', function () {
            getSettings().defaultCapture = String($(this).val());
            saveFavorites();
        })
        .on('input.replyFavorites change.replyFavorites', '#rf-image-render-mode, #rf-image-theme, #rf-image-background, #rf-image-background-color, #rf-image-title, #rf-image-subtitle, #rf-image-show-date', saveImagePreferences)
        .on('change.replyFavorites', '#rf-select-all', function () {
            for (const item of filteredItems) {
                this.checked ? selectedIds.add(item.id) : selectedIds.delete(item.id);
            }
            renderGallery();
        })
        .on('change.replyFavorites', '.rf-card-check input', function () {
            const id = $(this).closest('.rf-card').data('favorite-id');
            this.checked ? selectedIds.add(id) : selectedIds.delete(id);
            renderGallery();
        })
        .on('input.replyFavorites', '.rf-title, .rf-collections, .rf-tags, .rf-note', function () {
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
        .on('change.replyFavorites', '.rf-title, .rf-collections, .rf-tags, .rf-note', function () {
            renderGallery();
            toastr.success('已保存', '', { timeOut: 900 });
        })
        .on('click.replyFavorites', '.rf-remove', async function () {
            await removeFavorite($(this).closest('.rf-card').data('favorite-id'), true);
        })
        .on('click.replyFavorites', '.rf-jump', async function () {
            const item = getSettings().items.find(entry => entry.id === $(this).closest('.rf-card').data('favorite-id'));
            if (item) await jumpToFavorite(item);
        })
        .on('click.replyFavorites', '.rf-card-image', async function () {
            const item = getSettings().items.find(entry => entry.id === $(this).closest('.rf-card').data('favorite-id'));
            if (!item) return;
            await exportImages([item], `${item.characterName}-回复珍藏`);
        })
        .on('click.replyFavorites', '#rf-export-md', exportMarkdown)
        .on('click.replyFavorites', '#rf-export-json', exportJsonBackup)
        .on('click.replyFavorites', '.rf-import-json', function () {
            $('#rf-import-file').data('mode', $(this).data('mode')).trigger('click');
        })
        .on('change.replyFavorites', '#rf-import-file', async function () {
            await importJsonFile(this.files?.[0], $(this).data('mode') || 'merge');
        })
        .on('click.replyFavorites', '#rf-delete-selected', deleteSelected)
        .on('click.replyFavorites', '#rf-dedupe', removeDuplicates)
        .on('click.replyFavorites', '#rf-random', revisitRandom)
        .on('click.replyFavorites', '#rf-export-image', async () => {
            await exportImages(getExportItems(), '回复珍藏馆');
        })
        .on('keydown.replyFavorites', function (event) {
            if (event.key !== 'Escape') return;
            if ($('.rf-data-menu[open]').length) {
                $('.rf-data-menu').prop('open', false);
                return;
            }
            if ($('#rf-overlay').hasClass('rf-open')) closeGallery();
        });
}

function initialize() {
    getSettings();
    $('#rf-overlay, #rf-open-fab').remove();
    $('.rf-settings').remove();
    document.documentElement.insertAdjacentHTML('beforeend', galleryMarkup());
    $('#extensions_settings2').append(settingsMarkup());
    bindEvents();
    $('#rf-default-capture').val(getSettings().defaultCapture);
    updateImageSettingsUi();
    enhanceMessages();

    const previousHandlers = globalThis[EVENT_HANDLERS_KEY];
    if (Array.isArray(previousHandlers)) {
        for (const [eventName, handler] of previousHandlers) {
            eventSource.removeListener(eventName, handler);
        }
    }
    const eventHandlers = [];
    const listen = (eventName, handler) => {
        eventSource.on(eventName, handler);
        eventHandlers.push([eventName, handler]);
    };
    [
        event_types.CHAT_CHANGED,
        event_types.CHAT_LOADED,
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_SWIPED,
        event_types.MORE_MESSAGES_LOADED,
    ].filter(Boolean).forEach(eventName => listen(eventName, messageIndex => {
        setTimeout(enhanceMessages, 0);
        scheduleFavoriteSnapshotSync(messageIndex);
    }));
    globalThis[EVENT_HANDLERS_KEY] = eventHandlers;
    scheduleFavoriteSnapshotSync();
}

jQuery(initialize);
