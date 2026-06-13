// ==UserScript==
// @name         LINUX DO 增强工具 (时间排序 + 头像/标题预览增强版)
// @namespace    http://tampermonkey.net/
// @version      6.10
// @description  1. 强制首页/最新页按创建时间排序；2. 电脑端鼠标悬停标题预览；3. 手机端点击用户头像预览；4. 预览支持作者信息、手动关闭、滚动隔离、嵌套楼层展开与顺滑定位。
// @author       Gemini
// @match        https://linux.do/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // 展开楼层时会在弹窗内加载同站 iframe，避免脚本在 iframe 内再次创建预览层。
    try {
        if (window.self !== window.top) return;
    } catch (e) {
        return;
    }

    // ==========================================
    // 功能一：原生参数强制按创建时间排序
    // ==========================================
    function enforceCreatedOrder() {
        const url = new URL(window.location.href);
        const isLatestPage = url.pathname === '/' || url.pathname === '/latest';

        if (isLatestPage && !url.searchParams.has('order')) {
            url.searchParams.set('order', 'created');
            window.location.replace(url.toString());
        }
    }

    enforceCreatedOrder();


    // ==========================================
    // 功能二：多端自适应正文预览系统 (纯净头像触发版)
    // ==========================================
    let hoverTimeout = null;
    let hideTimeout = null;
    let tooltip = null;
    let tooltipBackdrop = null;
    let currentTopicId = null;
    let lastCoord = { pageX: 0, pageY: 0, clientX: 0, clientY: 0 };
    let isExpandedPreview = false;
    let lockedScrollState = null;
    let lastPreviewTouch = null;
    let expandedScrollSession = null;
    const previewCache = new Map();
    const expandedTopicPrefetchCache = new Map();
    const MAX_EXPANDED_PREFETCHES = 6;

    const previewScopeStyle = `
        <style>
            #tm-preview-tooltip * { box-sizing: border-box; }
            #tm-preview-inner p { margin: 0 0 8px 0 !important; padding: 0 !important; }
            #tm-preview-inner blockquote { margin: 8px 0 !important; padding: 8px 12px !important; border-left: 4px solid var(--primary-low, #e9e9e9); background: var(--primary-very-low, #f4f4f4); }
            #tm-preview-inner ul, #tm-preview-inner ol { margin: 6px 0 !important; padding-left: 22px !important; }
            #tm-preview-inner li { margin-bottom: 3px !important; }
            #tm-preview-inner pre { margin: 8px 0 !important; padding: 10px !important; max-height: 180px; overflow-y: auto; border-radius: 6px; }
            #tm-preview-inner code { font-size: 13px; }
            #tm-preview-inner h1, #tm-preview-inner h2, #tm-preview-inner h3 { margin: 10px 0 6px 0 !important; font-size: 1.12em !important; }
            .tm-preview-shell { display: flex; flex-direction: column; min-height: 0; height: 100%; }
            .tm-preview-topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
            .tm-preview-author { display: flex; align-items: center; gap: 10px; min-width: 0; }
            .tm-preview-avatar { width: 42px; height: 42px; flex: 0 0 42px; border-radius: 50%; object-fit: cover; background: var(--primary-low, #e9e9e9); }
            .tm-preview-avatar-fallback { display: inline-flex; align-items: center; justify-content: center; font-weight: 700; }
            .tm-preview-author-text { min-width: 0; }
            .tm-preview-name { color: var(--primary, #222222); font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .tm-preview-username { color: var(--primary-medium, #777777); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .tm-preview-title { margin: 0 0 12px 0; color: var(--primary-high, #111111); font-weight: 700; font-size: 16px; line-height: 1.35; }
            .tm-preview-body { min-height: 0; }
            .tm-preview-actions { display: flex; justify-content: center; gap: 8px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--primary-low, #e9e9e9); }
            .tm-preview-button { appearance: none; border: 1px solid var(--tertiary, #0088cc); background: var(--tertiary, #0088cc); color: var(--secondary, #ffffff); border-radius: 8px; padding: 8px 14px; font-size: 14px; font-weight: 700; cursor: pointer; line-height: 1.2; }
            .tm-preview-button:hover { filter: brightness(0.96); }
            .tm-preview-button[disabled] { opacity: 0.68; cursor: progress; }
            .tm-preview-close { appearance: none; border: 0; background: transparent; color: var(--primary-medium, #777777); width: 34px; height: 34px; flex: 0 0 34px; border-radius: 50%; font-size: 25px; line-height: 30px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
            .tm-preview-close:hover { background: var(--primary-low, #e9e9e9); color: var(--primary, #222222); }
            .tm-preview-expanded-shell { position: relative; height: 100%; contain: layout paint; }
            .tm-preview-frame-wrap { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; overscroll-behavior: contain; background: var(--secondary, #ffffff); }
            .tm-preview-frame { position: relative; z-index: 1; width: 100%; height: 100%; border: 0; display: block; background: var(--secondary, #ffffff); overscroll-behavior: contain; touch-action: pan-y; }
            .tm-preview-frame-status { position: absolute; inset: 0; z-index: 0; display: flex; align-items: center; justify-content: center; padding: 20px; color: var(--primary-medium, #777777); font-style: italic; text-align: center; pointer-events: none; }
            .tm-preview-expanded-close { position: absolute; z-index: 3; right: 0; top: 50%; transform: translateY(-50%); width: 36px; height: 52px; border-radius: 18px 0 0 18px; background: rgba(0,0,0,0.42); color: #ffffff; box-shadow: 0 4px 16px rgba(0,0,0,0.22); }
            .tm-preview-expanded-close:hover { background: rgba(0,0,0,0.58); color: #ffffff; }
            .tm-preview-loading { color: var(--primary-medium, #777777); font-style: italic; padding: 6px 0; }
            @media (max-width: 768px) {
                .tm-preview-topbar { gap: 8px; }
                .tm-preview-avatar { width: 36px; height: 36px; flex-basis: 36px; }
                .tm-preview-title { font-size: 15px; }
                .tm-preview-actions { justify-content: stretch; }
                .tm-preview-button { width: 100%; padding: 10px 12px; }
                .tm-preview-expanded-close { right: 0; top: 66%; width: 34px; height: 56px; border-radius: 18px 0 0 18px; font-size: 24px; background: rgba(0,0,0,0.46); }
            }
        </style>
    `;

    // 初始化预览卡片容器
    function createTooltip() {
        if (tooltip) return;
        tooltipBackdrop = document.createElement('div');
        tooltipBackdrop.id = 'tm-preview-backdrop';
        tooltipBackdrop.style.cssText = `
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.18);
            z-index: 99998;
            display: none;
            pointer-events: auto;
            overscroll-behavior: contain;
        `;
        document.body.appendChild(tooltipBackdrop);
        tooltipBackdrop.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, true);
        tooltipBackdrop.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isExpandedPreview && window.innerWidth > 768) closeTooltip();
        }, true);

        tooltip = document.createElement('div');
        tooltip.id = 'tm-preview-tooltip';
        tooltip.style.cssText = `
            position: absolute;
            background: var(--secondary, #ffffff);
            color: var(--primary, #222222);
            border: 1px solid var(--primary-low, #e9e9e9);
            padding: 16px 20px;
            border-radius: 12px;
            box-shadow: 0 12px 40px rgba(0,0,0,0.22);
            z-index: 99999;
            font-size: 15px;
            line-height: 1.5;
            display: none;
            word-break: break-word;
            white-space: normal;
            pointer-events: auto;
            box-sizing: border-box;
            overscroll-behavior: contain;
        `;
        document.body.appendChild(tooltip);

        tooltip.addEventListener('wheel', containPreviewScroll, { passive: false });
        tooltip.addEventListener('touchstart', (e) => {
            const touch = e.touches?.[0];
            lastPreviewTouch = touch ? { clientX: touch.clientX, clientY: touch.clientY } : null;
        }, { passive: true });
        tooltip.addEventListener('touchmove', containPreviewScroll, { passive: false });
        tooltip.addEventListener('touchend', () => { lastPreviewTouch = null; }, { passive: true });
        tooltip.addEventListener('touchcancel', () => { lastPreviewTouch = null; }, { passive: true });

        tooltip.addEventListener('click', (e) => {
            const actionEl = e.target.closest('[data-tm-preview-action]');
            if (!actionEl) return;

            e.preventDefault();
            e.stopPropagation();

            const action = actionEl.getAttribute('data-tm-preview-action');
            if (action === 'close') {
                closeTooltip();
                return;
            }

            if (action === 'expand') {
                const topicId = actionEl.getAttribute('data-topic-id') || currentTopicId;
                if (topicId) {
                    actionEl.setAttribute('disabled', 'disabled');
                    actionEl.textContent = '正在展开...';
                    prefetchExpandedTopic(topicId);
                    showExpandedTopic(topicId);
                }
            }
        });

        // 电脑端悬停卡片稳住逻辑
        tooltip.addEventListener('mouseover', () => { if (window.innerWidth > 768) clearTimeout(hideTimeout); });
        tooltip.addEventListener('mouseout', (e) => {
             if (isExpandedPreview) return;
             if (window.innerWidth <= 768) return;
             const relatedTarget = e.relatedTarget;
             if (relatedTarget && tooltip.contains(relatedTarget)) return;
             startHideTooltip();
        });
    }

    // 从复杂的响应式列表行中精准向上逆推捞取帖子 ID
    function getTopicIdFromElement(targetEl) {
        let current = targetEl;
        while (current && current !== document.body) {
            // 适配现代 Discourse 属性绑定的 tr 行
            if (current.getAttribute('data-topic-id')) {
                return current.getAttribute('data-topic-id');
            }
            // 适配手机端各类流式布局容器 item
            if (current.classList.contains('topic-list-item') ||
                current.classList.contains('latest-topic-list-item') ||
                current.classList.contains('topic-list-data') ||
                current.classList.contains('search-result-topic') ||
                current.classList.contains('fps-result') ||
                current.tagName === 'TR' ||
                current.tagName === 'LI' ||
                current.classList.contains('suggested-topics-list-item') ||
                current.closest('.suggested-topics-list tr')) {

                // 在当前行容器中检索任何指向帖子的链接
                const topicLink = current.querySelector('a[href*="/t/"]');
                if (topicLink) {
                    const id = extractTopicId(topicLink.getAttribute('href'));
                    if (id) return id;
                }
            }
            current = current.parentNode;
        }
        return null;
    }

    // 跨端响应式位置校准算法
    function repositionTooltip(coord) {
        if (!tooltip || tooltip.style.display === 'none') return;

        const isMobile = window.innerWidth <= 768;
        tooltip.style.padding = isExpandedPreview ? '0' : '16px 20px';

        if (isExpandedPreview) {
            tooltip.style.position = 'fixed';
            tooltip.style.width = isMobile ? 'calc(100vw - 12px)' : 'min(1120px, calc(100vw - 48px))';
            tooltip.style.height = isMobile ? 'calc(100dvh - 16px)' : 'calc(100vh - 32px)';
            tooltip.style.maxWidth = 'none';
            tooltip.style.maxHeight = 'none';
            tooltip.style.left = '50%';
            tooltip.style.top = isMobile ? '8px' : '16px';
            tooltip.style.transform = 'translateX(-50%)';
            tooltip.style.overflow = 'hidden';
            return;
        }

        tooltip.style.height = 'auto';
        tooltip.style.overflow = 'auto';

        if (isMobile) {
            // 手机端：固定于屏幕中央
            tooltip.style.position = 'fixed';
            tooltip.style.width = '92vw';
            tooltip.style.maxWidth = '450px';
            tooltip.style.left = '50%';
            tooltip.style.top = '50%';
            tooltip.style.transform = 'translate(-50%, -50%)';
            tooltip.style.maxHeight = '78vh';
            tooltip.style.overflowY = 'auto';
        } else {
            // 电脑端：高精度鼠标跟随避让
            tooltip.style.position = 'absolute';
            tooltip.style.transform = 'none';
            tooltip.style.width = '880px';
            tooltip.style.maxWidth = 'calc(100vw - 40px)';
            tooltip.style.maxHeight = '72vh';
            tooltip.style.overflowY = 'auto';

            const gap = 20;
            const tooltipWidth = tooltip.offsetWidth;
            const tooltipHeight = tooltip.offsetHeight;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            let left = coord.pageX + gap;
            let top = coord.pageY + gap;

            if (coord.clientX + gap + tooltipWidth > viewportWidth) {
                left = coord.pageX - tooltipWidth - gap;
                if (left < window.scrollX + 10) {
                    left = window.scrollX + viewportWidth - tooltipWidth - 20;
                }
            }
            if (left < window.scrollX + 10) left = window.scrollX + 10;

            if (coord.clientY + gap + tooltipHeight > viewportHeight) {
                top = coord.pageY - tooltipHeight - gap;
                if (top < window.scrollY + 10) {
                    top = window.scrollY + 10;
                }
            }

            tooltip.style.left = `${left}px`;
            tooltip.style.top = `${top}px`;
        }
    }

    function extractTopicId(href) {
        if (!href) return null;
        try {
            const url = new URL(href, window.location.origin);
            const match = url.pathname.match(/\/t\/(?:[^\/]+\/)?(\d+)/);
            return match ? match[1] : null;
        } catch (e) {
            return null;
        }
    }

    function startHideTooltip() {
        if (isExpandedPreview) return;
        clearTimeout(hideTimeout);
        hideTimeout = setTimeout(() => {
            closeTooltip(false);
        }, 180);
    }

    function getElementTarget(target) {
        if (!target) return null;
        if (target.nodeType === Node.ELEMENT_NODE) return target;
        return target.parentElement || null;
    }

    function canScrollInDirection(element, deltaX, deltaY) {
        if (!element || element === document || element === document.documentElement || element === document.body) return false;

        const style = window.getComputedStyle(element);
        const canScrollY = /(auto|scroll|overlay)/.test(style.overflowY) || element === tooltip;
        const canScrollX = /(auto|scroll|overlay)/.test(style.overflowX);
        const hasVerticalRoom = element.scrollHeight > element.clientHeight + 1;
        const hasHorizontalRoom = element.scrollWidth > element.clientWidth + 1;

        if (deltaY < 0 && canScrollY && hasVerticalRoom && element.scrollTop > 0) return true;
        if (deltaY > 0 && canScrollY && hasVerticalRoom && element.scrollTop + element.clientHeight < element.scrollHeight - 1) return true;
        if (deltaX < 0 && canScrollX && hasHorizontalRoom && element.scrollLeft > 0) return true;
        if (deltaX > 0 && canScrollX && hasHorizontalRoom && element.scrollLeft + element.clientWidth < element.scrollWidth - 1) return true;

        return false;
    }

    function findPreviewScrollTarget(target, deltaX, deltaY) {
        let current = getElementTarget(target);
        while (current && current !== document.body) {
            if (tooltip.contains(current) && canScrollInDirection(current, deltaX, deltaY)) {
                return current;
            }
            if (current === tooltip) break;
            current = current.parentElement;
        }

        return tooltip;
    }

    function containPreviewScroll(e) {
        if (!tooltip || tooltip.style.display !== 'block') return;
        if (!tooltip.contains(e.target)) return;

        if (isExpandedPreview) {
            const eventTarget = getElementTarget(e.target);
            if (eventTarget?.closest('.tm-preview-frame')) return;
            return;
        }

        let deltaX = 0;
        let deltaY = 0;

        if (e.type === 'wheel') {
            const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? tooltip.clientHeight : 1;
            deltaX = e.deltaX * scale;
            deltaY = e.deltaY * scale;
        } else if (e.type === 'touchmove') {
            const touch = e.touches?.[0];
            if (!touch) return;
            if (!lastPreviewTouch) {
                lastPreviewTouch = { clientX: touch.clientX, clientY: touch.clientY };
                return;
            }
            deltaX = lastPreviewTouch.clientX - touch.clientX;
            deltaY = lastPreviewTouch.clientY - touch.clientY;
            lastPreviewTouch = { clientX: touch.clientX, clientY: touch.clientY };
        }

        if (e.cancelable) e.preventDefault();
        e.stopPropagation();

        const scrollTarget = findPreviewScrollTarget(e.target, deltaX, deltaY);
        if (!scrollTarget) return;

        scrollTarget.scrollLeft += deltaX;
        scrollTarget.scrollTop += deltaY;
    }

    function closeTooltip(clearContent = true) {
        clearTimeout(hoverTimeout);
        clearTimeout(hideTimeout);
        clearExpandedScrollSession();
        lastPreviewTouch = null;
        unlockPageScroll();
        if (!tooltip) return;
        tooltip.style.display = 'none';
        if (tooltipBackdrop) tooltipBackdrop.style.display = 'none';
        if (clearContent) tooltip.innerHTML = '';
        currentTopicId = null;
        isExpandedPreview = false;
    }

    function lockPageScroll() {
        if (lockedScrollState) return;
        const scrollbarGap = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
        const currentBodyPaddingRight = parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
        lockedScrollState = {
            htmlOverflow: document.documentElement.style.overflow,
            bodyOverflow: document.body.style.overflow,
            bodyTouchAction: document.body.style.touchAction,
            bodyPaddingRight: document.body.style.paddingRight
        };
        if (scrollbarGap > 0) {
            document.body.style.paddingRight = `${currentBodyPaddingRight + scrollbarGap}px`;
        }
        document.documentElement.style.overflow = 'hidden';
        document.body.style.overflow = 'hidden';
        document.body.style.touchAction = 'none';
    }

    function unlockPageScroll() {
        if (!lockedScrollState) return;
        document.documentElement.style.overflow = lockedScrollState.htmlOverflow;
        document.body.style.overflow = lockedScrollState.bodyOverflow;
        document.body.style.touchAction = lockedScrollState.bodyTouchAction;
        document.body.style.paddingRight = lockedScrollState.bodyPaddingRight;
        lockedScrollState = null;
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    function escapeAttr(value) {
        return escapeHtml(value).replace(/`/g, '&#96;');
    }

    function normalizeUrl(src) {
        if (!src) return '';
        if (src.startsWith('//')) return `${window.location.protocol}${src}`;
        if (src.startsWith('/')) return `${window.location.origin}${src}`;
        return src;
    }

    function getExpandedTopicUrl(topicId) {
        return `/n/topic/${encodeURIComponent(topicId)}?sort=top`;
    }

    function rememberExpandedTopicPrefetch(absoluteHref, request) {
        while (expandedTopicPrefetchCache.size >= MAX_EXPANDED_PREFETCHES) {
            const oldestHref = expandedTopicPrefetchCache.keys().next().value;
            expandedTopicPrefetchCache.delete(oldestHref);
        }
        expandedTopicPrefetchCache.set(absoluteHref, request);
    }

    function prefetchExpandedTopic(topicId) {
        if (!topicId || !document.head) return;
        const href = getExpandedTopicUrl(topicId);
        const absoluteHref = new URL(href, window.location.origin).href;
        if (expandedTopicPrefetchCache.has(absoluteHref)) {
            return expandedTopicPrefetchCache.get(absoluteHref);
        }

        const existing = Array.from(document.head.querySelectorAll('link[rel="prefetch"]'))
            .some(link => link.href === absoluteHref || link.getAttribute('href') === href);
        if (!existing) {
            const link = document.createElement('link');
            link.rel = 'prefetch';
            link.as = 'document';
            link.href = href;
            document.head.appendChild(link);
        }

        const request = fetch(href, {
            credentials: 'same-origin',
            cache: 'force-cache'
        })
            .then(response => response.ok ? response.text() : null)
            .then(() => null)
            .catch(() => null);

        rememberExpandedTopicPrefetch(absoluteHref, request);
        return request;
    }

    function scheduleExpandedTopicPrefetch(topicId) {
        if (!topicId) return;
        const run = () => prefetchExpandedTopic(topicId);
        setTimeout(run, 0);
    }

    function avatarUrlFromTemplate(template, size = 90) {
        if (!template) return '';
        return normalizeUrl(template.replace('{size}', String(size)));
    }

    function buildTopicMeta(topicId, data, firstPost) {
        const displayName = firstPost?.name || firstPost?.display_username || firstPost?.username || '未知用户';
        const username = firstPost?.username || firstPost?.display_username || '';
        const title = data?.title || data?.fancy_title || '';
        const avatarUrl = avatarUrlFromTemplate(firstPost?.avatar_template, 90);

        return {
            topicId,
            displayName,
            username,
            title,
            avatarUrl
        };
    }

    function renderAuthorBlock(meta) {
        const initial = escapeHtml((meta.displayName || meta.username || '?').trim().charAt(0).toUpperCase() || '?');
        const avatar = meta.avatarUrl
            ? `<img class="tm-preview-avatar" src="${escapeAttr(meta.avatarUrl)}" alt="">`
            : `<span class="tm-preview-avatar tm-preview-avatar-fallback">${initial}</span>`;
        const username = meta.username ? `@${meta.username}` : '';

        return `
            <div class="tm-preview-author">
                ${avatar}
                <div class="tm-preview-author-text">
                    <div class="tm-preview-name">${escapeHtml(meta.displayName || meta.username || '未知用户')}</div>
                    <div class="tm-preview-username">${escapeHtml(username)}</div>
                </div>
            </div>
        `;
    }

    function renderPreviewHtml(topicId, meta, contentHtml) {
        const titleHtml = meta.title ? `<div class="tm-preview-title">${escapeHtml(meta.title)}</div>` : '';

        return `
            ${previewScopeStyle}
            <div class="tm-preview-shell" data-topic-id="${escapeAttr(topicId)}">
                <div class="tm-preview-topbar">
                    ${renderAuthorBlock(meta)}
                    <button class="tm-preview-close" type="button" title="关闭" aria-label="关闭预览" data-tm-preview-action="close">&times;</button>
                </div>
                ${titleHtml}
                <div id="tm-preview-inner" class="tm-preview-body">${contentHtml}</div>
                <div class="tm-preview-actions">
                    <button class="tm-preview-button" type="button" data-tm-preview-action="expand" data-topic-id="${escapeAttr(topicId)}">展开其他楼层</button>
                </div>
            </div>
        `;
    }

    function getFrameDocument(frame) {
        try {
            return frame?.contentDocument || frame?.contentWindow?.document || null;
        } catch (e) {
            return null;
        }
    }

    function getFrameScrollRoot(doc) {
        return doc?.scrollingElement || doc?.documentElement || doc?.body || null;
    }

    function getPostRootElement(element) {
        if (!element) return null;
        return element.closest('article.topic-post, .topic-post, article[id^="post_"], [id^="post_"][data-post-id], [data-post-id][data-post-number], article') || element;
    }

    function isVisibleElement(element, minHeight = 8) {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > minHeight;
    }

    function isVisiblePostElement(element) {
        return isVisibleElement(element, 24);
    }

    function getVisiblePostElements(doc) {
        if (!doc?.body) return null;

        const candidates = Array.from(doc.querySelectorAll([
            'article.topic-post',
            '.topic-post',
            'article[id^="post_"]',
            '[id^="post_"][data-post-id]',
            '[data-post-id][data-post-number]',
            '.topic-body'
        ].join(',')));

        const seen = new Set();
        const posts = [];
        for (const candidate of candidates) {
            const post = getPostRootElement(candidate);
            if (!post || seen.has(post) || !doc.body.contains(post)) continue;
            if (post.closest('.suggested-topics, .related-messages, .topic-list')) continue;
            if (!isVisiblePostElement(post)) continue;
            seen.add(post);
            posts.push(post);
        }

        posts.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        return posts;
    }

    function findFirstReplyElement(doc) {
        const posts = getVisiblePostElements(doc);
        if (!posts) return null;

        // posts[0] is the main topic post. posts[1] is the first visible floor below it
        // in the currently rendered order, regardless of whether the page labels it as "1F".
        return posts[1] || null;
    }

    function getExpandedAnchorSignature(element) {
        const className = typeof element.className === 'string' ? element.className : '';
        return `${element.id || ''} ${className} ${element.getAttribute('aria-label') || ''} ${element.getAttribute('title') || ''} ${element.textContent || ''}`;
    }

    function scoreExpandedActionAnchor(element) {
        const signature = getExpandedAnchorSignature(element).toLowerCase();
        let score = 0;

        if (/topic-footer-buttons|topic-footer-main-buttons|topic-actions|topic-footer/.test(signature)) score += 80;
        if (/share|bookmark|flag|invite|assign|notification|分享|书签|举报|指定|常规/.test(signature)) score += 40;
        if (/nested-view__controls|nested-sort-selector/.test(signature)) score += 55;
        if (/nested-view__topic-map|topic-map/.test(signature)) score += 35;
        if (/topic-sort|sort|排序依据|热门/.test(signature)) score += 20;
        if (/post-menu-area|post-controls/.test(signature)) score += 6;

        return score;
    }

    function normalizeExpandedActionAnchor(element) {
        return element.closest([
            '#topic-footer-buttons',
            '.topic-footer-main-buttons',
            '.topic-footer-buttons',
            '.topic-actions',
            '.topic-footer',
            '.topic-notifications-options',
            '.nested-view__controls',
            '.nested-sort-selector',
            '.nested-view__topic-map',
            '.topic-map',
            '.post-menu-area',
            '.post-controls'
        ].join(',')) || element;
    }

    function findExpandedActionAnchor(doc, mainPost, firstReply) {
        if (!doc?.body || !mainPost) return null;

        const mainRect = mainPost.getBoundingClientRect();
        const firstReplyRect = firstReply?.getBoundingClientRect();
        const minTop = mainRect.bottom - 180;
        const maxTop = firstReplyRect ? firstReplyRect.top + 24 : Number.POSITIVE_INFINITY;
        const selector = [
            '#topic-footer-buttons',
            '.topic-footer-main-buttons',
            '.topic-footer-buttons',
            '.topic-footer',
            '.topic-actions',
            '.topic-notifications-button',
            '.topic-notifications-options',
            '.nested-view__controls',
            '.nested-sort-selector',
            '.nested-view__topic-map',
            '.topic-map',
            '.topic-sort',
            '.topic-sort-by',
            '.post-menu-area',
            '.post-controls',
            'button.share-and-invite',
            'button.bookmark',
            'button.flag-topic',
            'button.btn[title*="分享"]',
            'button.btn[title*="书签"]',
            'button.btn[title*="举报"]',
            'button.btn[title*="指定"]',
            'button[aria-label*="分享"]',
            'button[aria-label*="书签"]',
            'button[aria-label*="举报"]',
            'button[aria-label*="指定"]'
        ].join(',');

        const seen = new Set();
        const anchors = [];
        for (const candidate of Array.from(doc.querySelectorAll(selector))) {
            const anchor = normalizeExpandedActionAnchor(candidate);
            if (!anchor || seen.has(anchor) || !doc.body.contains(anchor)) continue;
            if (!isVisibleElement(anchor, 6)) continue;

            const rect = anchor.getBoundingClientRect();
            if (rect.top < minTop || rect.top > maxTop) continue;

            const score = scoreExpandedActionAnchor(anchor);
            if (score <= 0) continue;

            seen.add(anchor);
            anchors.push({ element: anchor, score, top: rect.top });
        }

        anchors.sort((a, b) => b.score - a.score || a.top - b.top);
        return anchors[0]?.element || null;
    }

    function findExpandedScrollTarget(doc) {
        const posts = getVisiblePostElements(doc);
        if (!posts?.length) return null;

        const mainPost = posts[0];
        const firstReply = posts[1] || null;
        const actionAnchor = findExpandedActionAnchor(doc, mainPost, firstReply);

        return {
            anchor: actionAnchor || firstReply || mainPost,
            firstReply
        };
    }

    function getExpandedFrameTopCover(doc) {
        const win = doc?.defaultView;
        if (!win || !doc?.body) return 0;

        const viewportHeight = win.innerHeight || doc.documentElement.clientHeight || 0;
        const selector = [
            'header.d-header',
            '.d-header',
            '.d-header-wrap',
            '.topic-title-sticky',
            '.topic-title-sticky-wrapper',
            '.topic-progress-wrapper',
            '.topic-progress',
            '.topic-timeline'
        ].join(',');
        let coveredBottom = 0;

        for (const element of Array.from(doc.querySelectorAll(selector))) {
            const style = win.getComputedStyle(element);
            if (!/(fixed|sticky)/.test(style.position)) continue;

            const rect = element.getBoundingClientRect();
            if (rect.width < 80 || rect.height <= 0) continue;
            if (viewportHeight && rect.height > viewportHeight * 0.35) continue;
            if (rect.top > 6 || rect.bottom <= 0) continue;

            coveredBottom = Math.max(coveredBottom, rect.bottom);
        }

        return Math.min(coveredBottom, window.innerWidth <= 768 ? 132 : 160);
    }

    function getExpandedScrollSafeGap(doc) {
        const frameWidth = doc?.defaultView?.innerWidth || window.innerWidth;
        const baseGap = frameWidth <= 768 ? 10 : 12;
        return Math.round(getExpandedFrameTopCover(doc) + baseGap);
    }

    function clearExpandedScrollSession() {
        if (!expandedScrollSession) return;

        expandedScrollSession.timers.forEach(timer => clearTimeout(timer));
        expandedScrollSession.cleanup.forEach(cleanup => cleanup());
        expandedScrollSession = null;
    }

    function createExpandedScrollSession(frame) {
        clearExpandedScrollSession();
        expandedScrollSession = {
            frame,
            userInteracted: false,
            observedDoc: null,
            timers: [],
            cleanup: []
        };
        return expandedScrollSession;
    }

    function isActiveExpandedScrollSession(session) {
        return !!session &&
            session === expandedScrollSession &&
            isExpandedPreview &&
            tooltip?.style.display === 'block';
    }

    function markExpandedFrameUserInteracted(session) {
        if (!isActiveExpandedScrollSession(session) || session.userInteracted) return;

        session.userInteracted = true;
        session.timers.forEach(timer => clearTimeout(timer));
        session.timers = [];
    }

    function watchExpandedFrameUserIntent(session, doc) {
        if (!isActiveExpandedScrollSession(session) || !doc?.defaultView || session.observedDoc === doc) return;

        session.observedDoc = doc;
        const mark = () => markExpandedFrameUserInteracted(session);
        const pointerOptions = { capture: true, passive: true };

        doc.addEventListener('wheel', mark, pointerOptions);
        doc.addEventListener('touchstart', mark, pointerOptions);
        doc.addEventListener('pointerdown', mark, pointerOptions);
        doc.addEventListener('keydown', mark, true);
        session.cleanup.push(() => {
            doc.removeEventListener('wheel', mark, true);
            doc.removeEventListener('touchstart', mark, true);
            doc.removeEventListener('pointerdown', mark, true);
            doc.removeEventListener('keydown', mark, true);
        });
    }

    function scheduleExpandedScrollCorrection(session, frame, delay) {
        if (!isActiveExpandedScrollSession(session)) return;

        const timer = setTimeout(() => {
            session.timers = session.timers.filter(item => item !== timer);
            if (!isActiveExpandedScrollSession(session) || session.userInteracted) return;
            correctExpandedFrameScroll(frame, session);
        }, delay);
        session.timers.push(timer);
    }

    function applyExpandedFrameScrollTuning(doc) {
        if (!doc?.head || doc.getElementById('tm-expanded-frame-scroll-style')) return;

        const style = doc.createElement('style');
        style.id = 'tm-expanded-frame-scroll-style';
        style.textContent = `
            html, body {
                overscroll-behavior: contain !important;
            }
            body {
                touch-action: pan-y;
                -webkit-overflow-scrolling: touch;
            }
        `;
        doc.head.appendChild(style);
    }

    function markExpandedScrollTarget(doc, anchor, firstReply) {
        doc.querySelectorAll('[data-tm-expanded-scroll-anchor="true"]').forEach(el => {
            el.removeAttribute('data-tm-expanded-scroll-anchor');
        });
        doc.querySelectorAll('[data-tm-first-reply-target="true"]').forEach(el => {
            el.removeAttribute('data-tm-first-reply-target');
        });

        anchor?.setAttribute('data-tm-expanded-scroll-anchor', 'true');
        firstReply?.setAttribute('data-tm-first-reply-target', 'true');
    }

    function scrollExpandedFrameToTarget(doc, scrollRoot, targetInfo, behavior = 'smooth') {
        const anchor = targetInfo?.anchor;
        if (!anchor) return false;

        const prefersReducedMotion = doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        const safeGap = getExpandedScrollSafeGap(doc);
        const rect = anchor.getBoundingClientRect();
        const targetTop = Math.max(0, scrollRoot.scrollTop + rect.top - safeGap);

        markExpandedScrollTarget(doc, anchor, targetInfo.firstReply);
        try {
            scrollRoot.scrollTo({
                top: targetTop,
                behavior: prefersReducedMotion ? 'auto' : behavior
            });
        } catch (e) {
            scrollRoot.scrollTop = targetTop;
        }

        return true;
    }

    function correctExpandedFrameScroll(frame, session) {
        if (session && (!isActiveExpandedScrollSession(session) || session.userInteracted)) return;

        const doc = getFrameDocument(frame);
        const scrollRoot = getFrameScrollRoot(doc);
        if (!doc || !scrollRoot) return;

        if (session) watchExpandedFrameUserIntent(session, doc);

        let anchor = doc.querySelector('[data-tm-expanded-scroll-anchor="true"]');
        const markedReply = doc.querySelector('[data-tm-first-reply-target="true"]');
        if (!anchor || !markedReply) {
            const targetInfo = findExpandedScrollTarget(doc);
            if (!targetInfo?.anchor) return;
            anchor = targetInfo.anchor;
            markExpandedScrollTarget(doc, targetInfo.anchor, targetInfo.firstReply);
        }

        const safeGap = getExpandedScrollSafeGap(doc);
        const delta = anchor.getBoundingClientRect().top - safeGap;
        if (Math.abs(delta) < 28) return;

        try {
            scrollRoot.scrollTo({
                top: Math.max(0, scrollRoot.scrollTop + delta),
                behavior: 'auto'
            });
        } catch (e) {
            scrollRoot.scrollTop = Math.max(0, scrollRoot.scrollTop + delta);
        }
    }

    function scrollExpandedFrameToFirstReply(frame) {
        const session = createExpandedScrollSession(frame);
        let attempts = 0;
        const maxAttempts = 120;
        let didScroll = false;

        const tryScroll = () => {
            if (!isActiveExpandedScrollSession(session) || session.userInteracted) return;

            const doc = getFrameDocument(frame);
            const scrollRoot = getFrameScrollRoot(doc);
            const targetInfo = findExpandedScrollTarget(doc);

            if (doc) {
                applyExpandedFrameScrollTuning(doc);
                watchExpandedFrameUserIntent(session, doc);
            }

            if (scrollRoot && targetInfo?.anchor && (targetInfo.firstReply || attempts > 10)) {
                if (!didScroll) {
                    didScroll = true;
                    let appliedScroll = false;
                    const applyScroll = () => {
                        if (appliedScroll || !isActiveExpandedScrollSession(session) || session.userInteracted) return;
                        appliedScroll = true;
                        scrollExpandedFrameToTarget(doc, scrollRoot, targetInfo, 'smooth');
                        scheduleExpandedScrollCorrection(session, frame, 720);
                        scheduleExpandedScrollCorrection(session, frame, 1500);
                    };
                    requestAnimationFrame(applyScroll);
                    setTimeout(applyScroll, 80);
                }
                return;
            }

            attempts += 1;
            if (attempts < maxAttempts) {
                setTimeout(tryScroll, 100);
            }
        };

        tryScroll();
    }

    function showExpandedTopic(topicId) {
        createTooltip();

        const nestedUrl = getExpandedTopicUrl(topicId);

        isExpandedPreview = true;
        currentTopicId = topicId;
        lockPageScroll();
        if (tooltipBackdrop) tooltipBackdrop.style.display = 'block';
        tooltip.style.display = 'block';
        tooltip.innerHTML = `
            ${previewScopeStyle}
            <div class="tm-preview-shell tm-preview-expanded-shell" data-topic-id="${escapeAttr(topicId)}">
                <div class="tm-preview-frame-wrap">
                    <div class="tm-preview-frame-status">正在加载嵌套楼层...</div>
                    <iframe class="tm-preview-frame" src="${escapeAttr(nestedUrl)}" title="嵌套楼层预览" loading="eager" fetchpriority="high"></iframe>
                </div>
                <button class="tm-preview-close tm-preview-expanded-close" type="button" title="关闭" aria-label="关闭预览" data-tm-preview-action="close">&times;</button>
            </div>
        `;
        const frame = tooltip.querySelector('.tm-preview-frame');
        const frameStatus = tooltip.querySelector('.tm-preview-frame-status');
        let scrollStarted = false;
        const startFrameScroll = () => {
            if (!frame) return;
            if (scrollStarted) return;
            scrollStarted = true;
            if (frameStatus) frameStatus.style.display = 'none';
            scrollExpandedFrameToFirstReply(frame);
        };
        frame?.addEventListener('load', startFrameScroll, { once: true });
        setTimeout(startFrameScroll, 120);
        repositionTooltip(lastCoord);
    }

    // 抓取并展示
    async function fetchAndShowPreview(topicId, coord) {
        if (isExpandedPreview) return;
        createTooltip();
        currentTopicId = topicId;
        lastCoord = coord;
        const isMobile = window.innerWidth <= 768;
        if (isMobile) lockPageScroll();
        if (tooltipBackdrop) tooltipBackdrop.style.display = 'none';

        tooltip.style.display = 'block';
        tooltip.innerHTML = `${previewScopeStyle}<div class="tm-preview-loading">正在读取楼主正文...</div>`;
        repositionTooltip(coord);

        if (previewCache.has(topicId)) {
            tooltip.innerHTML = previewCache.get(topicId);
            repositionTooltip(coord);
            prefetchExpandedTopic(topicId);
            return;
        }

        try {
            const response = await fetch(`/t/${topicId}.json`);
            if (!response.ok) throw new Error();
            const data = await response.json();

            const firstPost = data.post_stream?.posts?.[0];
            if (firstPost && firstPost.cooked) {
                const meta = buildTopicMeta(topicId, data, firstPost);
                const tempEl = document.createElement('div');
                tempEl.innerHTML = firstPost.cooked;

                tempEl.querySelectorAll('img').forEach(img => {
                    let src = img.getAttribute('src');
                    if (src && src.startsWith('/')) src = window.location.origin + src;
                    if (src) {
                        img.src = src;
                        img.style.maxWidth = '100%';
                        img.style.maxHeight = isMobile ? '180px' : '260px';
                        img.style.height = 'auto';
                        img.style.display = 'block';
                        img.style.margin = '8px 0';
                        img.style.borderRadius = '6px';
                        img.setAttribute('loading', 'lazy');
                    }
                });

                let contentHtml = tempEl.innerHTML.trim();
                const finalHtml = renderPreviewHtml(topicId, meta, contentHtml);

                previewCache.set(topicId, finalHtml);
                scheduleExpandedTopicPrefetch(topicId);

                if (tooltip.style.display === 'block' && currentTopicId === topicId && !isExpandedPreview) {
                    tooltip.innerHTML = finalHtml;
                    repositionTooltip(coord);
                }
            } else {
                if (currentTopicId === topicId) tooltip.innerHTML = '<i>❌ 无法解析该帖子内容</i>';
            }
        } catch (err) {
            if (currentTopicId === topicId) tooltip.innerHTML = '<span style="color: var(--danger, #ff4d4f);">⚠️ 读取失败 (可能触发频率限制)</span>';
        }
    }

    // ==========================================
    // 核心事件监听流
    // ==========================================

    let lastUrl = location.href;
    const domObserver = new MutationObserver(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            enforceCreatedOrder();
        }
    });
    domObserver.observe(document, { subtree: true, childList: true });

    // [电脑端] 鼠标悬停标题逻辑
    document.addEventListener('mouseover', (e) => {
        if (window.innerWidth > 768) {
            if (isExpandedPreview) return;
            const topicLink = e.target.closest('a.raw-link, a.title, a.search-link');
            if (!topicLink) return;
            if (e.relatedTarget && (e.relatedTarget === tooltip || tooltip?.contains(e.relatedTarget))) return;

            const topicId = extractTopicId(topicLink.getAttribute('href'));
            if (!topicId) return;

            clearTimeout(hoverTimeout);
            lastCoord = { clientX: e.clientX, clientY: e.clientY, pageX: e.pageX, pageY: e.pageY };

            hoverTimeout = setTimeout(() => {
                clearTimeout(hideTimeout);
                fetchAndShowPreview(topicId, lastCoord);
            }, 500);
        }
    });

    document.addEventListener('mouseout', (e) => {
        if (window.innerWidth <= 768) return;
        if (isExpandedPreview) return;
        const topicLink = e.target.closest('a.raw-link, a.title, a.search-link');
        if (topicLink) {
            clearTimeout(hoverTimeout);
            const relatedTarget = e.relatedTarget;
            if (relatedTarget === null || (relatedTarget !== tooltip && !tooltip?.contains(relatedTarget))) {
                startHideTooltip();
            }
        }
    });

    // 🌟🌟🌟【唯一手机端点击头像处理器】
    // 移动端可能不会稳定派发 click，且 Ember/Discourse 有委托事件；这里用捕获级触摸/指针事件先拿到头像。
    const mobileAvatarSelector = '.avatar-wrapper, a.avatar, .poster-avatar, .posters a, a[data-user-card], img.avatar, [class*="avatar"]';
    let lastMobileAvatarTopicId = null;
    let lastMobileAvatarAt = 0;

    function getEventCoord(e) {
        const point = e.changedTouches?.[0] || e.touches?.[0] || e;
        const clientX = typeof point.clientX === 'number' ? point.clientX : 0;
        const clientY = typeof point.clientY === 'number' ? point.clientY : 0;
        const pageX = typeof point.pageX === 'number' ? point.pageX : window.scrollX + clientX;
        const pageY = typeof point.pageY === 'number' ? point.pageY : window.scrollY + clientY;
        return { clientX, clientY, pageX, pageY };
    }

    function stopMobileAvatarEvent(e) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') {
            e.stopImmediatePropagation();
        }
    }

    function handleMobileAvatarPreview(e) {
        if (window.innerWidth > 768) return; // 严格限制：只在手机端生效
        if (isExpandedPreview) return;

        const target = e.target instanceof Element ? e.target : e.target?.parentElement;
        if (!target) return;

        // 识别任何形式的头像元素（图片或其包裹容器）
        const avatarTarget = target.closest(mobileAvatarSelector);
        if (!avatarTarget) return;

        // 核心解密：尝试捞取帖子 ID
        const topicId = getTopicIdFromElement(avatarTarget);
        if (!topicId) return; // 如果此行拿不到帖子 ID（证明不是列表行），则放行，不破坏原生点击

        // 100% 成功拿到 ID，彻底阻止进帖子和进用户页
        stopMobileAvatarEvent(e);

        const now = Date.now();
        if (topicId === lastMobileAvatarTopicId &&
            now - lastMobileAvatarAt < 650 &&
            tooltip?.style.display === 'block' &&
            currentTopicId === topicId) {
            return;
        }

        lastMobileAvatarTopicId = topicId;
        lastMobileAvatarAt = now;

        // 触发全屏居中弹窗
        fetchAndShowPreview(topicId, getEventCoord(e));
    }

    const mobileCaptureOptions = { capture: true, passive: false };
    document.addEventListener('pointerup', handleMobileAvatarPreview, mobileCaptureOptions);
    document.addEventListener('touchend', handleMobileAvatarPreview, mobileCaptureOptions);
    document.addEventListener('click', handleMobileAvatarPreview, true);

    // 通用：点击外部空白收起
    document.addEventListener('pointerdown', (e) => {
        if (tooltip && tooltip.style.display === 'block') {
            if (isExpandedPreview) return;
            if (!tooltip.contains(e.target) && !e.target.closest('a.raw-link, a.title, a.search-link, .avatar-wrapper, a.avatar')) {
                closeTooltip();
            }
        }
    });

    window.addEventListener('resize', () => {
        if (tooltip && tooltip.style.display === 'block') {
            repositionTooltip(lastCoord);
        }
    });

})();
