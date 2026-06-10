/** LastUpdated: 12 May 2026 at 11:45:52
 * wos aide core code, including:
 * - WebFuncs: 通用 Web 操作函数，如文件下载、自动滚动、弹窗关闭等
 * - WebWait: 基于轮询的等待工具，支持等待元素出现/消失、文本匹配、URL 变化等
 * - WosInfo: WOS 会话信息获取，如 SID
 * - WosGoto: 基于 WOS 前端路由的页面跳转工具，支持跳转到各种结果页和详情页
 * - WosIdStore: 管理当前选中的 WOS ID 与相关数据的内存缓存，支持与页面 URL 同步
 * - wosUuidStore: 专门管理 WOS 页面 uuid 信息的缓存与抓取
 * */

class WebFuncs {
    static instance = null;
    static autoScrollTimer = null;
    static popupGuard = null;

    // WOS 页面常见干扰弹窗的关闭按钮选择器
    static popupDismissSelectors = [
        'button.onetrust-close-btn-handler.onetrust-close-btn-ui.banner-close-button.ot-close-icon',
        'button[aria-label="Close"].onetrust-close-btn-handler',
        '#onetrust-close-btn-container button',
        'button._pendo-close-guide[aria-label="Close"]',
        'button[id^="pendo-close-guide-"]',
    ];

    /** 获取 WebFuncs 单例实例
     */
    static getInstance() {
        return WebFuncs.instance || new WebFuncs();
    }

    /** 构造函数- 通过单例模式确保全局只创建一个实例
     */
    constructor() {
        if (WebFuncs.instance) {
            return WebFuncs.instance;
        }
        WebFuncs.instance = this;
    }

    /** 简单随机 hex */
    #randomHex(len) {
        const arr = new Uint8Array(len);
        if (crypto?.getRandomValues) {
            crypto.getRandomValues(arr);
        } else {
            for (let i = 0; i < len; i++) arr[i] = Math.floor(Math.random() * 256);
        }
        return [...arr].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, len);
    }

    /** (内部方法) 将给定内容封装为文件并触发浏览器下载
     * - content: 文件内容
     * - fileName: 下载文件名
     * - mimeType: 文件 MIME 类型
     * - 返回值: true，表示已触发下载动作
     */
    #downloadContent(content, fileName, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fileName;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return true;
    }

    /** (内部方法) 将单条对象记录转换为 BibTeX 文本
     * - defaultKey: 当记录没有 citeKey / id 时使用的默认键名
     */
    #toBibText(item, defaultKey = 'data') {
        if (!item) return '';
        const type = item.entryType || 'article';
        const key = item.citeKey || item.id || defaultKey;
        let bib = `@${type}{${key},\n`;
        for (const [k, v] of Object.entries(item)) {
            if (k === 'entryType' || k === 'citeKey' || k === 'id') continue;
            bib += `  ${k} = {${v}},\n`;
        }
        bib += '}\n';
        return bib;
    }

    /** 简单 UUID（你原来的格式）
     * 简单 UUID（你原来的格式）
     */
    randomUuid() {
        const parts = [8, 4, 4, 4, 12, 10].map(n => this.#randomHex(n));
        return parts.join('-');
    }

    /** 延时 毫秒
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /** 将对象或对象数组导出为 JSON 文件
     * - obj: 单条记录对象或记录数组
     * - name: 下载文件名（不含扩展名）
     * - 返回值: true，表示已触发下载动作
     */
    saveJsonToFile(obj, name = 'data') {
        return this.#downloadContent(
            JSON.stringify(obj, null, 2),
            `${name}.json`,
            'application/json;charset=utf-8'
        );
    }

    /** 将对象或对象数组导出为 BibTeX 文件
     * - obj: 单条记录对象或记录数组
     * - name: 下载文件名（不含扩展名）
     * - 返回值: true，表示已触发下载动作
     */
    saveBibToFile(obj, name = 'data') {
        const bibText = Array.isArray(obj)
            ? obj.map(item => this.#toBibText(item, name)).join('\n')
            : this.#toBibText(obj, name);
        return this.#downloadContent(bibText, `${name}.bib`, 'text/plain;charset=utf-8');
    }

    /** 将任意文本内容按指定扩展名导出为本地文件
     * - text: 要写入文件的文本内容
     * - name: 下载文件名（不含扩展名）
     * - ext: 文件扩展名，默认 txt
     * - addBOM: 是否在文本开头添加 UTF-8 BOM
     * - 返回值: true，表示已触发下载动作
     */
    async saveTextAsFile(text, name = 'text', ext = 'txt', addBOM = false) {
        const content = addBOM ? '\uFEFF' + String(text) : String(text);
        const fileName = `${name}.${ext}`;
        return this.#downloadContent(content, fileName, 'text/plain;charset=utf-8');
    }

    /** 自动滚动页面到底部，速度可调节
     * - speed: 每次滚动的像素值，默认 200
     * - 返回值: 滚动完成或已存在进行中的滚动任务时返回 Promise<void>
     */
    autoScroll(speed = 200) {
        return new Promise((resolve) => {
            if (WebFuncs.autoScrollTimer) return resolve();
            window.scrollTo(0, 0);
            const threshold = 20;
            WebFuncs.autoScrollTimer = setInterval(() => {
                window.scrollBy(0, speed);

                const scrollTop = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
                const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
                const documentHeight = Math.max(
                    document.body.scrollHeight,
                    document.documentElement.scrollHeight
                );

                if (scrollTop + viewportHeight + threshold >= documentHeight) {
                    clearInterval(WebFuncs.autoScrollTimer);
                    WebFuncs.autoScrollTimer = null;
                    resolve();
                }
            }, 10);
        });
    }

    /** 停止当前自动滚动任务
     * - resolveFn: 可选回调，停止后执行
     */
    stopAutoScroll(resolveFn) {
        if (WebFuncs.autoScrollTimer) {
            clearInterval(WebFuncs.autoScrollTimer);
            WebFuncs.autoScrollTimer = null;
            if (typeof resolveFn === 'function') resolveFn();
        }
    }

    /** 启动 WOS 页面干扰弹窗自动关闭功能: 关闭 cookie、guide、评分类弹窗
     * - options.intervalMs: 轮询间隔，默认 2500ms
     * - options.minClickGapMs: 两次点击的最小时间间隔，默认 500ms
     * - options.observeMs: 观察器持续时间，默认 10000ms
     * - options.observeAttributes: 是否同时监听属性变化
     * - options.debug: 是否输出调试日志
     * - 返回值: 守卫对象，包含 stop 和 dismissOnce 方法
     */
    startWosPopupGuard(options = {}) {
        if (WebFuncs.popupGuard) return WebFuncs.popupGuard;

        const {
            intervalMs = 2500,
            minClickGapMs = 500,
            observeMs = 10000,
            observeAttributes = false,
            debug = false,
        } = options;

        let lastClickAt = 0;

        const dismissKnownPopups = () => {
            const now = Date.now();
            if (now - lastClickAt < minClickGapMs) return false;

            for (const selector of WebFuncs.popupDismissSelectors) {
                const btn = document.querySelector(selector);
                if (!btn) continue;
                if (btn.disabled) continue;
                const style = window.getComputedStyle(btn);
                if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') continue;

                btn.click();
                lastClickAt = now;
                if (debug) console.debug('[WOS] popup dismissed:', selector);
                return true;
            }
            return false;
        };

        const observer = new MutationObserver(() => {
            dismissKnownPopups();
        });

        const observeOptions = {
            childList: true,
            subtree: true,
        };
        if (observeAttributes) {
            observeOptions.attributes = true;
            observeOptions.attributeFilter = ['class', 'style', 'aria-hidden'];
        }

        observer.observe(document.documentElement, observeOptions);

        // 首次触发 + 有限时长兜底，避免在 WOS 的 React 页面上长期监听整个 DOM
        dismissKnownPopups();
        const timer = intervalMs > 0 ? setInterval(dismissKnownPopups, intervalMs) : null;
        const stopTimer = Number.isFinite(observeMs) && observeMs > 0
            ? setTimeout(() => {
                WebFuncs.popupGuard?.stop?.();
            }, observeMs)
            : null;

        WebFuncs.popupGuard = {
            stop: () => {
                observer.disconnect();
                if (timer) clearInterval(timer);
                if (stopTimer) clearTimeout(stopTimer);
                WebFuncs.popupGuard = null;
            },
            dismissOnce: dismissKnownPopups,
        };
        return WebFuncs.popupGuard;
    }

    /** 停止 WOS 页面干扰弹窗自动关闭功能
     */
    stopWosPopupGuard() {
        WebFuncs.popupGuard?.stop?.();
    }
}
const webFuncs = WebFuncs.getInstance();
const asy_webFuncs = webFuncs;















class WebWait {
    static instance = null;

    static getInstance() {
        return WebWait.instance || new WebWait();
    }

    constructor() {
        if (WebWait.instance) return WebWait.instance;
        WebWait.instance = this;
    }

    /** (内部方法) 规范化等待参数，避免出现非法重试次数或负间隔
     * - maxTry: 期望的最大轮询次数
     * - interval: 期望的轮询间隔毫秒数
     * - 返回值: { tries, waitMs }
     */
    #normalizeWaitOptions(maxTry = 100, interval = 100) {
        return {
            tries: Number.isFinite(maxTry) && maxTry > 0 ? Math.floor(maxTry) : 1,
            waitMs: Number.isFinite(interval) && interval >= 0 ? interval : 100,
        };
    }

    /** (内部方法) 判断是否为非法 CSS 选择器错误
     * 判断是否为非法 CSS 选择器错误
     */
    #isInvalidSelectorError(error) {
        return error instanceof DOMException && error.name === 'SyntaxError';
    }

    /** (内部方法) 通用轮询模板
     * - checker: 每轮执行的检查函数，返回真值时立即结束
     * - maxTry: 最大轮询次数
     * - interval: 轮询间隔毫秒数
     * - 返回值: checker 返回的首个真值；超时时返回 null
     */
    async #pollUntil(checker, maxTry = 100, interval = 100) {
        const { tries, waitMs } = this.#normalizeWaitOptions(maxTry, interval);

        for (let i = 0; i < tries; i++) {
            const result = await checker();
            if (result) {
                return result;
            }
            if (i < tries - 1) {
                await webFuncs.sleep(waitMs);
            }
        }
        return null;
    }

    /** 轮询等待指定元素出现在当前页面中
     * - cssSelector: CSS 选择器
     * - maxTry: 最大轮询次数，默认 100
     * - interval: 每次轮询间隔，单位毫秒，默认 100
     * - 返回值: 找到时返回匹配到的第一个 DOM 元素；超时或选择器非法时返回 null
     */
    async waitForElementBySelector(cssSelector, maxTry = 100, interval = 100) {
        return this.#pollUntil(() => {
            try {
                return document.querySelector(cssSelector);
            } catch (error) {
                if (this.#isInvalidSelectorError(error)) {
                    console.warn(`[WOS] Invalid css selector: ${cssSelector}`);
                    return null;
                }
                throw error;
            }
        }, maxTry, interval);
    }

    /** 轮询等待指定元素从当前页面中消失
     * - cssSelector: CSS 选择器
     * - maxTry: 最大轮询次数，默认 100
     * - interval: 每次轮询间隔，单位毫秒，默认 100
     * - 返回值: 元素消失时返回 true；超时或选择器非法时返回 null
     */
    async waitForElementToDisappear(cssSelector, maxTry = 100, interval = 100) {
        return this.#pollUntil(() => {
            try {
                if (!document.querySelector(cssSelector)) {
                    return true;
                }
            } catch (error) {
                if (this.#isInvalidSelectorError(error)) {
                    console.warn(`[WOS] Invalid css selector: ${cssSelector}`);
                    return null;
                }
                throw error;
            }
            return false;
        }, maxTry, interval);
    }

    /** 轮询等待指定元素的子级元素数量发生变化
     * - cssSelector: CSS 选择器
     * - previousCount: 变化前的元素数量
     * - maxTry: 最大轮询次数，默认 100
     * - interval: 每次轮询间隔，单位毫秒，默认 100
     * - 返回值: 元素数量发生变化时返回 true；超时或选择器非法时返回 null
     */
    async waitForElementCountToChange(cssSelector, previousCount, maxTry = 100, interval = 100) {
        return this.#pollUntil(() => {
            try {
                if (document.querySelectorAll(cssSelector).length !== previousCount) {
                    return true;
                }
            } catch (error) {
                if (this.#isInvalidSelectorError(error)) {
                    console.warn(`[WOS] Invalid css selector: ${cssSelector}`);
                    return null;
                }
                throw error;
            }
            return false;
        }, maxTry, interval);
    }

    /** 轮询等待指定元素的文本内容包含目标文本
     * - cssSelector: CSS 选择器
     * - expectedText: 期望包含的文本内容
     * - maxTry: 最大轮询次数，默认 100
     * - interval: 每次轮询间隔，单位毫秒，默认 100
     * - 返回值: 文本匹配时返回 true；超时或选择器非法时返回 null
     */
    async waitForElementTextToInclude(cssSelector, expectedText, maxTry = 100, interval = 100) {
        return this.#pollUntil(() => {
            try {
                const element = document.querySelector(cssSelector);
                if (element && element.textContent.includes(expectedText)) {
                    return true;
                }
            } catch (error) {
                if (this.#isInvalidSelectorError(error)) {
                    console.warn(`[WOS] Invalid css selector: ${cssSelector}`);
                    return null;
                }
                throw error;
            }
            return false;
        }, maxTry, interval);
    }

    /** 轮询等待当前页面 URL 发生变化
     * - maxTry: 最大轮询次数，默认 100
     * - interval: 每次轮询间隔，单位毫秒，默认 100
     * - startUrl: 起始 URL，默认取调用时的 window.location.href
     * - 返回值: URL 变化时返回 true；超时未变化时返回 null
     */
    async waitForUrlChange(maxTry = 100, interval = 100, startUrl = window.location.href) {
        return this.#pollUntil(() => {
            if (window.location.href !== startUrl) {
                return true;
            }
            return false;
        }, maxTry, interval);
    }
}
const webWait = WebWait.getInstance();
const asy_webWait = webWait;
















class WosInfo {
    static instance = null;

    static getInstance() {
        return WosInfo.instance || new WosInfo();
    }

    constructor() {
        if (WosInfo.instance) return WosInfo.instance;
        WosInfo.instance = this;
    }

    /** 获取当前 WOS 会话的 SID
     * - 返回值: 当前页面 sessionData 中的 SID；不存在时返回空字符串
     */
    get sid() {
        return window.sessionData?.BasicProperties?.SID || '';
    }
}
const wosInfo = WosInfo.getInstance();














class WosGoto {
    static instance = null;

    static getInstance() {
        return WosGoto.instance || new WosGoto();
    }

    constructor() {
        if (WosGoto.instance) return WosGoto.instance;
        WosGoto.instance = this;
    }

    /** 让 WOS 前端路由到指定路径，并在需要时等待目标状态就绪
     * - href: 目标路径
     * - waitForReady: 可选的等待函数，返回真值表示页面已就绪
     */
    async #pushRoute(href, waitForReady = null) {
        const currentHref = `${window.location.pathname}${window.location.search}`;
        if (currentHref === href) {
            if (typeof waitForReady === 'function') {
                await waitForReady();
            }
            return;
        }

        window.history.pushState({}, "", href);
        window.dispatchEvent(new Event("popstate"));

        if (typeof waitForReady === 'function') {
            await waitForReady();
        }
    }

    /** (内部方法) 规范化传入的 WOS ID；保留传入前缀，不强制补 `WOS:`
     * - wosid: 原始 WOS ID
     * - 返回值: 标准化后的 WOS ID；空值时返回空字符串
     */
    #normalizeWosId(wosid = '') {
        const normalized = String(wosid || '').trim();
        if (!normalized) {
            return '';
        }
        const fullRecordMatch = normalized.match(/\/full-record\/([^/?#\s]+)/i);
        const source = fullRecordMatch ? decodeURIComponent(fullRecordMatch[1]) : normalized;
        const prefixed = source.match(/^([A-Za-z][A-Za-z0-9]*)\s*[:：]\s*(.+)$/);
        if (prefixed) {
            const suffix = String(prefixed[2] || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
            return suffix ? `${prefixed[1].toUpperCase()}:${suffix}` : '';
        }
        return source.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    }

    /** (内部方法) 根据 WOS ID 跳转到指定页面，并等待页头文本渲染完成
     * - wosid: 目标 WOS ID
     * - href: 目标页面路径
     * - titleText: 页头应包含的文本
     * - 返回值: 标准化后的 WOS ID；缺失时返回 null
     */
    async #goToSummaryPageByWosId(wosid, href, titleText) {
        const normalizedWosId = this.#normalizeWosId(wosid);
        if (!normalizedWosId) {
            console.warn(`[WOS] Missing WOS ID for ${titleText} page navigation.`);
            return null;
        }

        await this.#pushRoute(href, async () => {
            await webWait.waitForElementTextToInclude('#GenericFD-article-metadata-parent', titleText, 50);
        });
        return normalizedWosId;
    }

    /** 跳转到 WOS 高级搜索页面，并等待输入区域渲染完成
     */
    async goToAdvancedSearchPage() {
        await this.#pushRoute("/wos/woscc/advanced-search", async () => {
            await webWait.waitForElementBySelector("#advancedSearchInputArea", 50);
        });
    }

    /** 跳转到 WOS 基本搜索页面，并等待搜索项区域渲染完成
     */
    async goToBasicSearchPage() {
        await this.#pushRoute("/wos/woscc/basic-search", async () => {
            await webWait.waitForElementBySelector('div[data-ta="search-terms"]', 50);
        });
    }

    /** 跳转到一个默认可用的结果页，作为后续检索流程的入口页面
     */
    async openDefaultResultsPage() {
        const href = `/wos/woscc/summary/71bc6d46-a5e5-40b3-abd6-79f92952b7fe-01896f03a6/relevance/1`;
        await this.#pushRoute(href, async () => {
            await webWait.waitForElementTextToInclude('a[data-ta="summary-record-title-link"]', 'HELLO, WORLD', 100);
        });
    }

    /** 跳转到 WOS 退出登录页面
     */
    signOut() {
        window.history.pushState({}, "", "/wos/my/sign-out");
        window.dispatchEvent(new Event("popstate"));
    }

    /** 使用 MUST 图书馆代理域名在新标签页打开 DOI 页面
     * - doi: 目标文献 DOI
     */
    openDoiPageViaMustProxy(doi) {
        window.open(`https://doi-org.libezproxy.must.edu.mo/${doi}`, "_blank");
    }

    /** 根据 WOS ID 跳转到文献详情页，并等待标题区域渲染完成
     * - wosid: 目标文献的 WOS ID，支持传入带或不带 `WOS:` 前缀的值
     */
    async goToFullRecordPageByWosId(wosid) {
        const normalizedWosId = this.#normalizeWosId(wosid);
        if (!normalizedWosId) {
            console.warn('[WOS] Missing WOS ID for full record page navigation.');
            return null;
        }

        const href = `/wos/woscc/full-record/${normalizedWosId}`;
        await this.#pushRoute(href, async () => {
            await webWait.waitForElementBySelector("#FullRTa-fullRecordtitle-0", 50);
        });
        return normalizedWosId;
    }

    /** 根据 WOS ID 跳转到引用文献汇总页
     * - wosid: 目标文献的 WOS ID
     */
    async goToCitationsPageByWosId(wosid) {
        const normalizedWosId = this.#normalizeWosId(wosid);
        return this.#goToSummaryPageByWosId(
            normalizedWosId,
            `/wos/woscc/citing-summary/${normalizedWosId}?from=woscc&type=colluid&eventMode=timeCitedOnSummary`,
            'Citations of'
        );
    }

    /** 根据 WOS ID 跳转到参考文献汇总页
     * - wosid: 目标文献的 WOS ID
     */
    async goToReferencesPageByWosId(wosid) {
        const normalizedWosId = this.#normalizeWosId(wosid);
        return this.#goToSummaryPageByWosId(
            normalizedWosId,
            `/wos/woscc/cited-references-summary/${normalizedWosId}?type=colluid&from=woscc`,
            'References of'
        );
    }

    /** 根据 WOS ID 跳转到相关文献汇总页
     * - wosid: 目标文献的 WOS ID
     */
    async goToRelatedRecordsPageByWosId(wosid) {
        const normalizedWosId = this.#normalizeWosId(wosid);
        return this.#goToSummaryPageByWosId(
            normalizedWosId,
            `/wos/woscc/related-records-summary/${normalizedWosId}?type=colluid&from=woscc`,
            'Related to'
        );
    }

    /** 根据两个 WOS ID 跳转到共引参考文献页面
     * - wosid1: 第一个 WOS ID
     * - wosid2: 第二个 WOS ID
     * - 返回值: 标准化后的两个 WOS ID；任一缺失时返回 null
     */
    async goToSharedReferencesPageByWosIds(wosid1, wosid2) {
        const normalizedWosId1 = this.#normalizeWosId(wosid1);
        const normalizedWosId2 = this.#normalizeWosId(wosid2);
        if (!normalizedWosId1 || !normalizedWosId2) {
            console.warn('[WOS] Missing WOS IDs for shared references page navigation.');
            return null;
        }

        await this.#pushRoute(
            `/wos/woscc/shared-references-summary/${normalizedWosId1}/${normalizedWosId2}?type=colluid&from=woscc`,
            async () => {
                await webWait.waitForElementTextToInclude('#GenericFD-article-metadata-parent', 'Shared references between', 50);
            }
        );
        return [normalizedWosId1, normalizedWosId2];
    }

    /** 跳转到指定的 WOS 页面路径，并等待 URL 确认变更
     * - href: 目标路径或完整 URL
     */
    async goToWosPage(href) {
        await this.#pushRoute(href);
        return true;
    }

}
const wosGoto = WosGoto.getInstance();










































/** 单例模式管理 WOS ID 对应的页面跳转、信息抓取与本地缓存
 */
class WosIdStore {
    static instance = null;
    static def_value = 'A1993KH59100006';

    static getInstance() {
        return WosIdStore.instance || new WosIdStore();
    }

    constructor() {
        if (WosIdStore.instance) return WosIdStore.instance;
        WosIdStore.instance = this;
        this._value = WosIdStore.def_value;
        this.db = {};
    }

    /** 规范化 WOS ID；保留传入前缀，不强制补 `WOS:`
     * - wosid: 原始 WOS ID
     * - 返回值: 标准化后的 WOS ID；空值时返回空字符串
     */
    #normalizeWosId(wosid = '') {
        const normalized = String(wosid || '').trim();
        if (!normalized) {
            return '';
        }
        const fullRecordMatch = normalized.match(/\/full-record\/([^/?#\s]+)/i);
        const source = fullRecordMatch ? decodeURIComponent(fullRecordMatch[1]) : normalized;
        const prefixed = source.match(/^([A-Za-z][A-Za-z0-9]*)\s*[:：]\s*(.+)$/);
        if (prefixed) {
            const suffix = String(prefixed[2] || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
            return suffix ? `${prefixed[1].toUpperCase()}:${suffix}` : '';
        }
        return source.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    }

    /** 将数据按 WOS ID 合并写入当前会话的内存缓存
     * - wosid: 目标 WOS ID
     * - data: 要合并到缓存中的数据对象
     */
    mergeIntoCache(wosid, data) {
        const normalizedWosId = this.#normalizeWosId(wosid);
        if (!normalizedWosId) {
            console.warn('No WOS ID provided to mergeIntoCache().');
            return;
        }

        if (!this.db[normalizedWosId]) this.db[normalizedWosId] = {};

        const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

        const deepEqual = (a, b) => {
            if (a === b) return true;
            try {
                return JSON.stringify(a) === JSON.stringify(b);
            } catch (e) {
                return false;
            }
        };

        const mergeArrays = (oldArr, newArr) => {
            const res = oldArr.slice();
            newArr.forEach(n => {
                const exists = res.some(o => deepEqual(o, n));
                if (!exists) res.push(n);
            });
            return res;
        };

        const mergeValues = (oldVal, newVal) => {
            if (Array.isArray(oldVal) && Array.isArray(newVal)) {
                return mergeArrays(oldVal, newVal);
            }
            if (isPlainObject(oldVal) && isPlainObject(newVal)) {
                const merged = { ...oldVal };
                for (const k of Object.keys(newVal)) {
                    if (k in merged) {
                        merged[k] = mergeValues(merged[k], newVal[k]);
                    } else {
                        merged[k] = newVal[k];
                    }
                }
                return merged;
            }
            if (Array.isArray(oldVal) && !Array.isArray(newVal)) {
                const exists = oldVal.some(o => deepEqual(o, newVal));
                return exists ? oldVal.slice() : oldVal.concat([newVal]);
            }
            if (!Array.isArray(oldVal) && Array.isArray(newVal)) {
                const base = Array.isArray(oldVal) ? oldVal.slice() : (oldVal === undefined ? [] : [oldVal]);
                return mergeArrays(base, newVal);
            }
            return newVal;
        };

        for (const key of Object.keys(data || {})) {
            const newVal = data[key];
            if (key in this.db[normalizedWosId]) {
                this.db[normalizedWosId][key] = mergeValues(this.db[normalizedWosId][key], newVal);
            } else {
                this.db[normalizedWosId][key] = Array.isArray(newVal) ? newVal.slice() : (isPlainObject(newVal) ? { ...newVal } : newVal);
            }
        }
    }

    /** 设置当前选中的 WOS ID
     * - wosid: 允许传入带或不带 `WOS:` 前缀的值
     */
    set currentWosId(wosid = '') {
        const normalizedWosId = this.#normalizeWosId(wosid);
        if (!normalizedWosId) {
            return;
        }
        this._value = normalizedWosId;
    }

    /** 获取当前选中的 WOS ID
     */
    get currentWosId() {
        return this._value;
    }

    /** 从当前页面 URL 中提取并同步当前 WOS ID
     * - 返回值: 更新后的 WOS ID；当前页面不是记录页时返回 null
     */
    async syncCurrentWosIdFromUrl() {
        const href = window.location.href;
        const wosid = this.#normalizeWosId(href.split('/').pop());
        if (!wosid) {
            console.log('Not on a WOS record page. Cannot update WOS ID.');
            return null;
        }
        this._value = wosid;
        return this._value;
    }

    /** 查看指定 WOS ID 的详情页，并同步当前选中的 WOS ID
     * - wosid: 目标 WOS ID
     */
    async viewFullRecordByWosId(wosid = '') {
        this.currentWosId = wosid;
        return wosGoto.goToFullRecordPageByWosId(this.currentWosId);
    }

    /** 收集指定 WOS ID 的引用文献汇总页信息，并写入内存缓存
     * - wosid: 目标 WOS ID
     */
    async collectCitationsByWosId(wosid = '') {
        this.currentWosId = wosid;
        await wosGoto.goToCitationsPageByWosId(this.currentWosId);
        await this.#saveCitations();
    }

    /** 将当前引用文献页的 uuid 信息保存到本地缓存
     */
    async #saveCitations() {
        const res = await wosUuidStore.fetchCurrentPageInfo(`citations of ${this.currentWosId}`);
        this.mergeIntoCache(this.currentWosId, { citations: res });
    }

    /** 收集指定 WOS ID 的参考文献汇总页信息，并写入内存缓存
     * - wosid: 目标 WOS ID
     */
    async collectReferencesByWosId(wosid = '') {
        this.currentWosId = wosid;
        await wosGoto.goToReferencesPageByWosId(this.currentWosId);
        await this.#saveReferences();
    }

    /** 将当前参考文献页的 uuid 信息保存到本地缓存
     */
    async #saveReferences() {
        const res = await wosUuidStore.fetchCurrentPageInfo(`references of ${this.currentWosId}`);
        this.mergeIntoCache(this.currentWosId, { references: res });
    }

    /** 收集指定 WOS ID 的相关文献汇总页信息，并写入内存缓存
     * - wosid: 目标 WOS ID
     */
    async collectRelatedRecordsByWosId(wosid = '') {
        this.currentWosId = wosid;
        await wosGoto.goToRelatedRecordsPageByWosId(this.currentWosId);
        await this.#saveRelated();
    }

    /** 将当前相关文献页的 uuid 信息保存到本地缓存
     */
    async #saveRelated() {
        const res = await wosUuidStore.fetchCurrentPageInfo(`related of ${this.currentWosId}`);
        this.mergeIntoCache(this.currentWosId, { related: res });
    }

    /** 收集两个 WOS ID 之间的共享参考文献页面信息，并保存对应的 uuid 信息
     * - wosid1: 第一个 WOS ID
     * - wosid2: 第二个 WOS ID
     */
    async collectSharedReferencesBetweenWosIds(wosid1, wosid2) {
        const result = await wosGoto.goToSharedReferencesPageByWosIds(wosid1, wosid2);
        if (!result) {
            return null;
        }
        const [normalizedWosId1, normalizedWosId2] = result;
        await this.#saveSharedReferencesBetween(normalizedWosId1, normalizedWosId2);
    }

    /** 将共享参考文献页面对应的 uuid 信息保存到 uuid 缓存中
     */
    async #saveSharedReferencesBetween(wosid1, wosid2) {
        const res = await wosUuidStore.fetchCurrentPageInfo(`Shared references between ${wosid1} and ${wosid2}`);
        if (res?.uuid) {
            wosUuidStore.currentUuid = res.uuid;
            wosUuidStore.mergeIntoCache(res.uuid, res);
        }
    }

    /** 请求 WOS 导出接口，获取指定 WOS ID 的原始文本内容
     * - wosid: 目标 WOS ID
     * - 返回值: 成功时返回导出的原始文本；失败时返回 null
     */
    async fetchFullRecordExportTextByWosId(wosid = '') {
        this.currentWosId = wosid;
        const requestBody = {
            ids: [this.currentWosId],
            displayTimesCited: 'true',
            displayCitedRefs: 'true',
            product: 'UA',
            colName: 'WOS',
            displayUsageInfo: 'true',
            fileOpt: 'othersoftware',
            action: 'saveToTab',
            locale: 'en_US',
            view: 'fullrec',
            filters: "fullRecord"
        };

        const sid = wosInfo.sid;
        const headers = {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            ...(sid ? { 'x-1p-wos-sid': sid } : {}),
        };

        try {
            const response = await fetch(`${window.location.origin}/api/wosnx/indic/export/saveToFile`, {
                method: 'POST',
                credentials: 'same-origin',
                headers,
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                console.error(`request:wosid: ${this.currentWosId} \n status code: ${response.status}`);
                return null;
            }

            return await response.text();
        } catch (error) {
            console.error(`request error:wosid: ${this.currentWosId}`, error);
            return null;
        }
    }

    /** 将 WOS 导出接口返回的制表符文本解析为记录对象数组
     * - text: 导出接口返回的原始文本
     * - 返回值: 解析成功时返回对象数组；空文本或格式异常时返回空数组
     * - 说明: 这个方法可用于多条记录的导出文本，不限定为单个 WOS ID
     */
    parseTabDelimitedRecords(text = '') {
        const normalizedText = String(text || '').trim();
        if (!normalizedText) {
            return [];
        }

        const lines = normalizedText.split("\n");
        if (lines.length === 0) {
            return [];
        }

        const headers = lines[0].split("\t").map(header => header.trim());
        return lines.slice(1)
            .filter(line => line.trim())
            .map(line =>
                Object.fromEntries(
                    line.split("\t").map((value, index) => [headers[index], value.trim()])
                )
            );
    }

    /** 将单个 WOS ID 导出的制表符文本解析为单条记录对象
     * - text: 单个 WOS ID 导出接口返回的原始文本
     * - 返回值: 成功时返回单条记录对象；为空、格式异常或包含多条记录时返回 null
     * - 说明: 这个方法只适用于“一个 WOS ID 对应一条记录”的场景，不应用于批量导出文本
     */
    parseSingleTabDelimitedRecord(text = '') {
        const records = this.parseTabDelimitedRecords(text);
        if (records.length !== 1) {
            if (records.length > 1) {
                console.warn(`[WOS] Expected a single tab-delimited record, but received ${records.length} records.`);
            }
            return null;
        }
        return records[0];
    }

    /** 获取指定 WOS ID 的完整文献 JSON 数据，并保存到本地缓存
     * - wosid: 目标 WOS ID
     * - 返回值: 成功时返回 `{ [wosid]: json }`，失败时返回 null
     */
    async fetchFullRecordJsonByWosId(wosid = '') {
        this.currentWosId = wosid;
        const text = await this.fetchFullRecordExportTextByWosId(this.currentWosId);
        if (!text) {
            return null;
        }

        const record = this.parseSingleTabDelimitedRecord(text);
        if (!record) {
            return null;
        }

        this.mergeIntoCache(this.currentWosId, record);
        return { [this.currentWosId]: record };
    }


    /** 展开当前 WOS full record 页面中的折叠信息，再解析为 JSON 对象
     * - root: full record 主内容 DOM，默认 `#snMainArticle`
     * - options.delay: 每次点击后的等待时间，默认 350ms
     * - options.rounds: 展开轮次，默认 4
     */
    async parseWosFullRecordAfterExpand(root = document.querySelector('#snMainArticle'), options = {}) {
        await this.expandWosFullRecord(root, options);
        return this.parseWosFullRecord(root);
    }

    /** 展开当前 WOS full record 页面中可展开的记录字段
     * - root: full record 主内容 DOM，默认 `#snMainArticle`
     * - 返回值: 已尝试点击的唯一控件数量
     */
    async expandWosFullRecord(root = document.querySelector('#snMainArticle'), options = {}) {
        if (!root) {
            return 0;
        }

        const delay = options.delay ?? 350;
        const rounds = options.rounds ?? 4;
        const clicked = new Set();

        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

        const clean = s =>
            (s || '')
                .replace(/\s+/g, ' ')
                .trim();

        const visible = el => {
            if (!el) return false;
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                style.opacity !== '0' &&
                rect.width > 0 &&
                rect.height > 0;
        };

        const keyOf = el =>
            [
                el.id,
                el.getAttribute('data-ta'),
                el.getAttribute('aria-label'),
                clean(el.textContent)
            ].filter(Boolean).join('|');

        const shouldClick = el => {
            if (!visible(el)) return false;

            const tag = el.tagName.toLowerCase();
            const href = el.getAttribute('href') || '';

            if (tag === 'a' && href && !href.startsWith('javascript:') && href !== '#') {
                return false;
            }

            const signal = clean([
                el.id,
                el.getAttribute('data-ta'),
                el.getAttribute('aria-label'),
                el.getAttribute('aria-expanded'),
                el.textContent,
                el.querySelector('mat-icon')?.textContent
            ].join(' '));

            if (/close|fewer|less|collapse|back|clear|add journal|view record in/i.test(signal)) {
                return false;
            }

            if (el.getAttribute('aria-expanded') === 'false') return true;

            return /show|view|expand|more|arrow_drop_down|journal impact|researcherid|orcid|details|data fields|funding/i.test(signal);
        };

        for (let round = 0; round < rounds; round++) {
            const controls = [
                ...root.querySelectorAll('mat-expansion-panel-header[aria-expanded="false"]'),
                ...root.querySelectorAll('button'),
                ...root.querySelectorAll('a[role="button"]'),
                ...root.querySelectorAll('[role="button"][aria-expanded="false"]')
            ].filter(shouldClick);

            let count = 0;

            for (const el of controls) {
                const key = keyOf(el);
                if (!key || clicked.has(key)) continue;

                clicked.add(key);

                try {
                    el.scrollIntoView({ block: 'center', inline: 'center' });
                    await sleep(80);
                    el.click();
                    count++;
                    await sleep(delay);
                } catch (error) {
                    console.debug('[WOS] Failed to expand full record control.', error);
                }
            }

            if (!count) break;
        }

        return clicked.size;
    }

    /** 解析 WOS full record 页面 DOM 或 HTML 字符串为 JSON 对象
     * - input: `#snMainArticle` DOM、Document、Element 或 HTML 字符串
     */
    parseWosFullRecord(input = document.querySelector('#snMainArticle')) {
        if (!input) {
            return null;
        }

        const doc = typeof input === 'string'
            ? new DOMParser().parseFromString(input, 'text/html')
            : input;

        const root = doc.querySelector?.('#snMainArticle') || doc;

        const $ = (selector, base = root) => base?.querySelector?.(selector) || null;
        const $$ = (selector, base = root) => [...(base?.querySelectorAll?.(selector) || [])];

        const clean = s =>
            (s || '')
                .replace(/open_in_new|arrow_drop_down|arrow_drop_up|expand_more|expand_less|chevron_right/g, ' ')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
                .replace(/\s+;/g, ';')
                .trim();

        const cleanText = el => {
            if (!el) return '';
            const clone = el.cloneNode(true);
            clone.querySelectorAll('mat-icon, script, style, .cdk-visually-hidden').forEach(x => x.remove());
            return clean(clone.textContent);
        };

        const text = (selector, base = root) => cleanText($(selector, base));

        const attr = (selector, name, base = root) =>
            $(selector, base)?.getAttribute(name)?.trim() || '';

        const absUrl = href => {
            if (!href) return '';
            if (/^(mailto:|https?:)/i.test(href)) return href;
            try {
                return new URL(href, location.origin).href;
            } catch (error) {
                return href;
            }
        };

        const uniq = arr => [...new Set(arr.filter(Boolean))];

        const dedupeObjects = (arr, keyFn = x => JSON.stringify(x)) => {
            const seen = new Set();
            return arr.filter(item => {
                const key = keyFn(item);
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        };

        const getById = id => text(`#${CSS.escape(id)}`);

        const directGridValue = labelId => {
            const label = $(`#${CSS.escape(labelId)}`);
            if (!label) return '';
            const container = label.closest('.source-info-piece, .hidden-data-item, .cdx-two-column-grid-container') || label.parentElement;
            if (!container) return '';
            const clone = container.cloneNode(true);
            clone.querySelector(`#${CSS.escape(labelId)}`)?.remove();
            clone.querySelectorAll('button, mat-icon, script, style').forEach(x => x.remove());
            return clean(clone.textContent);
        };

        const fieldByHeading = headingRegex => {
            const headings = $$('h2, h3');
            const heading = headings.find(h => headingRegex.test(cleanText(h)));
            if (!heading) return '';

            const box = heading.closest('.cdx-two-column-grid-container, .source-info-piece, .author-info-section, .hidden-data-item') || heading.parentElement;
            if (!box) return '';

            const clone = box.cloneNode(true);
            clone.querySelectorAll('h2, h3, button, mat-icon, script, style').forEach(x => x.remove());

            return clean(clone.textContent);
        };

        const links = (selector, base = root) =>
            $$(selector, base).map(a => ({
                text: cleanText(a),
                href: absUrl(a.getAttribute('href') || '')
            })).filter(x => x.text || x.href);

        const parseMetric = prefix => {
            const categories = $$(`[id^="${prefix}-category-name_"]`).map(el => {
                const index = el.id.match(/_(\d+)$/)?.[1];

                return {
                    category: cleanText(el),
                    edition: text(`#${CSS.escape(prefix)}-edition_${index}`),
                    rank: text(`#${CSS.escape(prefix)}-rank_${index}`),
                    quartile: text(`#${CSS.escape(prefix)}-quartile_${index}`)
                };
            });

            return {
                title: text(`#${CSS.escape(prefix)}`),
                year: text(`#${CSS.escape(prefix)}-year`),
                value: text(`#${CSS.escape(prefix)}-value`),
                secondaryLabel: text(`#${CSS.escape(prefix)}-journal-year`),
                secondaryValue: text(`#${CSS.escape(prefix)}-journal-value`),
                source: text(`#${CSS.escape(prefix)}-related-Info`),
                link: absUrl(attr(`#${CSS.escape(prefix)}-learnMore`, 'href')),
                categories
            };
        };

        const parseAuthorAffiliationNumbers = authorEl =>
            $$('a[id*="FrAddrNbr"]', authorEl)
                .map(a => cleanText(a).match(/\d+/)?.[0])
                .filter(Boolean);

        const authors = $$('span[id^="author-"]').map((authorEl, index) => {
            const link = $('a[id^="SumAuthTa-DisplayName"]', authorEl);
            const href = link?.getAttribute('href') || '';

            return {
                index,
                displayName: text('a[id^="SumAuthTa-DisplayName"] span', authorEl),
                fullName: text('span[id^="SumAuthTa-FrAuthStandard"] .value', authorEl),
                wosAuthorUrl: absUrl(href),
                wosAuthorRecordId: href.match(/\/record\/([^/?#]+)/)?.[1] || '',
                affiliationNumbers: parseAuthorAffiliationNumbers(authorEl)
            };
        }).filter(x => x.displayName || x.fullName);

        const authorIdentifiers = $$('app-full-record-author-identifiers tbody tr').map(row => {
            const researcherLink = $('td:nth-child(2) a', row);
            const orcidLink = $('td:nth-child(3) a', row);
            const orcidUrl = orcidLink?.getAttribute('href') || '';

            return {
                author: text('td:nth-child(1)', row),
                researcherId: text('td:nth-child(2) a span, td:nth-child(2) a', row),
                researcherIdUrl: absUrl(researcherLink?.getAttribute('href') || ''),
                orcid: orcidUrl.match(/\d{4}-\d{4}-\d{4}-\d{3}[\dX]/)?.[0] || text('td:nth-child(3) a span, td:nth-child(3) a', row),
                orcidUrl: absUrl(orcidUrl)
            };
        }).filter(x => x.author);

        const parseAffiliations = base =>
            $$('.rorDisplay', base).map(block => {
                const rorLink = $('a[href^="https://ror.org/"]', block);
                const affiliationLink = $('a:not([href^="https://ror.org/"]) span, a:not([href^="https://ror.org/"])', block);

                return {
                    organization: cleanText(affiliationLink),
                    organizationUrl: absUrl(affiliationLink?.closest?.('a')?.getAttribute('href') || ''),
                    rorId: cleanText(rorLink),
                    rorUrl: absUrl(rorLink?.getAttribute('href') || '')
                };
            }).filter(x => x.organization || x.rorId);

        const addresses = $$('app-full-record-addresses-data app-full-record-author-organization > div')
            .map(block => {
                const addressLink = $('a[id^="address_"]', block);
                if (!addressLink) return null;

                return {
                    number: text('sup strong', addressLink).replace(/\D/g, ''),
                    address: text('.value', addressLink),
                    affiliations: parseAffiliations(block)
                };
            })
            .filter(Boolean);

        const correspondingAddresses = $$('[id^="FRAiinTa-RepAddrTitle-"]').map(block => {
            const holder = block.closest('app-full-record-author-item') || block;

            return {
                author: text('.author-display-name', holder),
                role: cleanText(holder).includes('corresponding author') ? 'corresponding author' : '',
                address: text('[id^="FRAOrgTa-RepAddressFull"]', holder),
                affiliations: parseAffiliations(holder)
            };
        }).filter(x => x.author || x.address);

        const emails = uniq(
            $$('a[href^="mailto:"]').map(a =>
                a.getAttribute('href').replace(/^mailto:/i, '').trim()
            )
        );

        const authorKeywords = uniq(
            $$('a[id^="FRkeywordsTa-authorKeywordLink"] span')
                .map(cleanText)
        );

        const keywordsPlus = uniq(
            $$('a[id*="keywordPlus" i] span, a[id*="KeyWordPlus" i] span')
                .map(cleanText)
        );

        const allKeywordLinks = links('app-full-record-keywords a');

        const researchAreas = uniq(
            $$('[id^="CategoriesTa-subject-"]')
                .map(cleanText)
        );

        const citationTopics = links('a[id^="CategoriesTa-citationTopic"] span')
            .map(x => x.text);

        const sustainableDevelopmentGoals = links('a[id^="CategoriesTa-sdg-category"] span')
            .map(x => x.text);

        const wosCategories = links('a[id^="CategoriesTa-WOSCategory"] span')
            .map(x => x.text);

        const meshTerms = (() => {
            const rows = $$('#CategoriesTa-meshTerms-table tbody tr');
            const terms = [];

            for (const row of rows) {
                const firstCell = $('td:nth-child(1)', row);
                const heading = text('td:nth-child(1) a span, td:nth-child(1) a', row);
                const qualifier = text('td:nth-child(2)', row);
                const majorTopic = cleanText(firstCell).startsWith('*');

                if (heading) {
                    terms.push({
                        heading,
                        majorTopic,
                        qualifiers: qualifier ? [qualifier] : []
                    });
                } else if (qualifier && terms.length) {
                    terms[terms.length - 1].qualifiers.push(qualifier);
                }
            }

            return terms;
        })();

        const fundingText = text('app-full-record-funding #FundingTa-fundAck + .value');

        const funding = $$('app-full-record-funding td[id^="FundingTa-fundingShowHide-"]').map(td => {
            const index = td.id.match(/-(\d+)$/)?.[1];
            const row = td.closest('tr');
            const detailRow = row?.nextElementSibling;
            const detailText = cleanText(detailRow);

            return {
                agency: text(`[id="FundingTa-fundingShowHide-${index}-agencyName"]`),
                agencyUrl: absUrl(attr(`#FundingTa-fundingShowHide-${index} a`, 'href')),
                grantNumbers: uniq(
                    $$(`#FundingTa-fund-table-grant-${index} a span, #FundingTa-fund-table-grant-${index} a`)
                        .map(cleanText)
                ),
                grantUrls: uniq(
                    $$(`#FundingTa-fund-table-grant-${index} a`)
                        .map(a => absUrl(a.getAttribute('href') || ''))
                ),
                details: detailText,
                appearedInSourceAs: detailText.match(/Appeared in source as:\s*(.+)$/i)?.[1] || ''
            };
        }).filter(x => x.agency || x.grantNumbers.length);

        const documentTypes = $$('[id^="FullRTa-doctype-"]')
            .map(el => cleanText(el).replace(/;$/, '').trim())
            .filter(Boolean);

        const citationSubsets = $$('[id^="HiddenSecTa-citationSubset-"]')
            .map(cleanText)
            .filter(Boolean);

        const sourceTitleEl = $('.source-title-display a:first-of-type');
        const sourceTitle = cleanText($('.source-title-display mark')) || cleanText(sourceTitleEl);

        const data = {
            title: text('#FullRTa-fullRecordtitle-0'),

            authors,
            authorIdentifiers,

            source: {
                title: sourceTitle,
                titleUrl: absUrl(sourceTitleEl?.getAttribute('href') || ''),
                publisher: text('#jcrSidenav-0-pub-name .cdx-right-panel-sub:last-child'),
                volume: getById('FullRTa-volume'),
                issue: getById('FullRTa-issue'),
                page: getById('FullRTa-pageNo'),
                articleNumber: getById('FullRTa-articleNumberValue'),
                doi: getById('FullRTa-DOI'),
                published: getById('FullRTa-pubdate'),
                earlyAccess: getById('FullRTa-earlyAccess'),
                indexed: getById('FullRTa-indexedDate'),
                documentTypes
            },

            journalMetrics: {
                journal: text('#jcrSidenav-0-main-header'),
                publisher: text('#jcrSidenav-0-pub-name .cdx-right-panel-sub:last-child'),
                jif: parseMetric('Sidenav-0-JCR'),
                jci: parseMetric('Sidenav-0-JCI')
            },

            abstract: text('#FullRTa-abstract-basic'),

            keywords: {
                authorKeywords,
                keywordsPlus,
                allKeywordLinks
            },

            authorInformation: {
                correspondingAddresses,
                emails,
                addresses
            },

            statements: {
                dataAvailability: fieldByHeading(/^data availability statement$/i),
                conflictOfInterest: fieldByHeading(/^conflict of interest statement$/i)
            },

            categories: {
                researchAreas,
                citationTopics,
                sustainableDevelopmentGoals,
                wosCategories,
                meshTerms
            },

            funding: {
                text: fundingText,
                items: funding
            },

            identifiers: {
                language: getById('HiddenSecTa-language-0'),
                accessionNumber: getById('HiddenSecTa-accessionNo'),
                pubmedId: getById('HiddenSecTa-pubmedId'),
                issn: getById('HiddenSecTa-ISSN'),
                eissn: getById('HiddenSecTa-EISSN'),
                idsNumber: getById('HiddenSecTa-recordIds'),
                citationSubsets
            },

            links: {
                doi: getById('FullRTa-DOI') ? `https://doi.org/${getById('FullRTa-DOI')}` : '',
                source: absUrl(sourceTitleEl?.getAttribute('href') || ''),
                jcr: absUrl(attr('#Sidenav-0-JCR-learnMore', 'href')),
                jci: absUrl(attr('#Sidenav-0-JCI-learnMore', 'href'))
            }
        };

        data.authors = data.authors.map(author => {
            const matchedIdentifier = data.authorIdentifiers.find(x =>
                x.author &&
                (
                    x.author === author.fullName ||
                    x.author === author.displayName ||
                    author.fullName?.includes(x.author) ||
                    x.author?.includes(author.fullName)
                )
            );

            return {
                ...author,
                researcherId: matchedIdentifier?.researcherId || '',
                researcherIdUrl: matchedIdentifier?.researcherIdUrl || '',
                orcid: matchedIdentifier?.orcid || '',
                orcidUrl: matchedIdentifier?.orcidUrl || '',
                addresses: author.affiliationNumbers
                    .map(n => data.authorInformation.addresses.find(a => a.number === n))
                    .filter(Boolean)
            };
        });

        data.authorInformation.addresses = dedupeObjects(
            data.authorInformation.addresses,
            x => `${x.number}|${x.address}`
        );

        data.funding.items = dedupeObjects(
            data.funding.items,
            x => `${x.agency}|${x.grantNumbers.join(',')}`
        );

        return data;
    }

    /** 解析当前 WOS full record 页面中的文献完整信息为 JSON 对象，并合并到本地缓存
     * - wosid: 可选目标 WOS ID；为空时从当前 URL 或页面数据同步
     * - 返回值: 成功时返回 `{ [wosid]: json }`，失败时返回 null
    */
    async parseCurrentFullRecordPage(wosid = '', options = {}) {
        if (wosid) {
            this.currentWosId = wosid;
        } else {
            await this.syncCurrentWosIdFromUrl();
        }

        const root = await webWait.waitForElementBySelector('#snMainArticle', 60, 100);
        if (!root) {
            console.warn('[WOS] Failed to find #snMainArticle on current full record page.');
            return null;
        }

        const record = await this.parseWosFullRecordAfterExpand(root, options);
        if (!record) {
            return null;
        }

        const pageWosId = this.#normalizeWosId(record.identifiers?.accessionNumber || '');
        if (pageWosId) {
            this.currentWosId = pageWosId;
        }

        this.mergeIntoCache(this.currentWosId, record);
        return { [this.currentWosId]: record };
    }





















}
const wosIdStore = WosIdStore.getInstance();












































class WosUuidStore {
    static instance = null;
    static def_value = '71bc6d46-a5e5-40b3-abd6-79f92952b7fe-01896f03a6';

    static getInstance() {
        return WosUuidStore.instance || new WosUuidStore();
    }

    constructor() {
        if (WosUuidStore.instance) return WosUuidStore.instance;
        WosUuidStore.instance = this;
        this._value = WosUuidStore.def_value;
        this.db = {}; // 本地缓存 uuid 数据
    }

    /** 验证 uuid 格式（8-4-4-4-12-10 的十六进制组合）
     * 返回 boolean
     */
    #isValidUuid(uuid = '') {
        const s = String(uuid).trim();
        const re = /[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}-[A-Fa-f0-9]{10}/;
        return re.test(s);
    }

    /** 从文本中提取 uuid
     */
    #extractUuid(text = '') {
        const s = String(text || '');
        const re = /[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}-[A-Fa-f0-9]{10}/;
        const m = s.match(re);
        return m ? m[0] : null;
    }

    /** 合并并保存 uuid 相关数据 
     * */
    mergeIntoCache(uuid, data) {
        // const uuid = this.#extractUuid(window.location.href) || WosUuidStore.def_value;
        if (!this.db[uuid]) this.db[uuid] = {};

        const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

        const deepEqual = (a, b) => {
            // 简单的深度比较，适用于常见对象/数组/基本类型
            if (a === b) return true;
            try {
                return JSON.stringify(a) === JSON.stringify(b);
            } catch (e) {
                return false;
            }
        };

        const mergeArrays = (oldArr, newArr) => {
            const res = oldArr.slice();
            newArr.forEach(n => {
                const exists = res.some(o => deepEqual(o, n));
                if (!exists) res.push(n);
            });
            return res;
        };

        const mergeValues = (oldVal, newVal) => {
            if (Array.isArray(oldVal) && Array.isArray(newVal)) {
                return mergeArrays(oldVal, newVal);
            }
            if (isPlainObject(oldVal) && isPlainObject(newVal)) {
                const merged = { ...oldVal };
                for (const k of Object.keys(newVal)) {
                    if (k in merged) {
                        merged[k] = mergeValues(merged[k], newVal[k]);
                    } else {
                        merged[k] = newVal[k];
                    }
                }
                return merged;
            }
            // 如果旧值是数组但新值不是，尝试把新值作为数组项加入（避免重复）
            if (Array.isArray(oldVal) && !Array.isArray(newVal)) {
                const exists = oldVal.some(o => deepEqual(o, newVal));
                return exists ? oldVal.slice() : oldVal.concat([newVal]);
            }
            // 如果旧值不是数组但新值是数组，将旧值与新数组合并
            if (!Array.isArray(oldVal) && Array.isArray(newVal)) {
                const base = Array.isArray(oldVal) ? oldVal.slice() : (oldVal === undefined ? [] : [oldVal]);
                return mergeArrays(base, newVal);
            }
            // 其他情况（基本类型或类型不匹配），以新值为准（覆盖）
            return newVal;
        };

        for (const key of Object.keys(data || {})) {
            const newVal = data[key];
            if (key in this.db[uuid]) {
                this.db[uuid][key] = mergeValues(this.db[uuid][key], newVal);
            } else {
                // 直接赋值（深拷贝浅实现）
                this.db[uuid][key] = Array.isArray(newVal) ? newVal.slice() : (isPlainObject(newVal) ? { ...newVal } : newVal);
            }
        }
    }

    /** 设置 uuid 的值,自动验证格式       
    */
    set currentUuid(uuid = '') {
        if (!uuid) return;
        uuid = String(uuid).trim();
        if (!this.#isValidUuid(uuid)) {
            console.warn(`Invalid UUID format: ${uuid}. Expected pattern 8-4-4-4-12-10 of hex chars.`);
            return;
        }
        this._value = uuid;
    }

    get currentUuid() {
        return this._value;
    }

    /** 兼容旧接口：验证 uuid 字符串
     */
    valid(uuid = '') {
        return this.#isValidUuid(uuid);
    }

    /** 兼容旧接口：从文本提取 uuid
     */
    extract(text = '') {
        return this.#extractUuid(text);
    }

    /** 兼容旧接口：合并缓存
     */
    save(uuid, data) {
        return this.mergeIntoCache(uuid, data);
    }

    /** 兼容旧接口：value <-> currentUuid
     */
    set value(uuid = '') {
        this.currentUuid = uuid;
    }

    get value() {
        return this.currentUuid;
    }

    /** 获取当前页面的 uuid 信息,并将相关信息合并到本地缓存中
    */
    async fetchCurrentPageInfo(note = '') {
        // 等待显示文献数据的元素是否有出现
        let res = {};
        const ele = await webWait.waitForElementBySelector('div[data-ta="search-info"]', 60, 100);
        if (!ele) {
            res = {
                uuid: '',
                ref_count: '',
                rowText: '',
                note,
                status: 'failed'
            };
        } else {
            const searchInfo = document.querySelector('div[data-ta="search-info"]');
            const rowTextElement = document.querySelector('.search-text');
            const uuid = searchInfo?.getAttribute('data-ta-search-info-qid') || '';
            const ref_count = searchInfo?.getAttribute('data-ta-search-info-count') || '';
            const rowText = rowTextElement?.textContent?.trim() || '';
            const hasValidSearchInfo = Boolean(uuid) && ref_count !== '';
            res = {
                uuid,
                ref_count,
                rowText,
                note,
                status: hasValidSearchInfo ? 'success' : 'failed'
            }
        }
        if (res.status === 'success' && res.uuid) {
            this.currentUuid = res.uuid;
            this.mergeIntoCache(this.currentUuid, res);
        }
        return res;
    }

    /** 兼容旧接口：获取当前页面 uuid 信息
     */
    async info(note = '') {
        return this.fetchCurrentPageInfo(note);
    }

    /** 兼容旧接口：从当前 URL 更新 uuid 并读取页面信息
     */
    async update() {
        const uuid = this.#extractUuid(window.location.href);
        if (!uuid) {
            console.warn('Failed to extract UUID from current page URL.');
            return null;
        }
        this.currentUuid = uuid;
        return this.fetchCurrentPageInfo();
    }

    /** 打开指定 UUID 的结果页并读取该页基础信息
     * - uuid: 目标结果集 UUID
     * - sortBy: 结果页排序方式，默认 `relevance`
     * - pageNumber: 结果页页码，默认第 1 页
     * - note: 附加说明文本
     * - 说明: 如果当前已经在相同 UUID、排序和页码的结果页，不会重复跳转
     * - 返回值: 成功时返回当前页信息对象，失败时返回 null
     */
    async #fetchPageInfoByUuid(uuid, sortBy = 'relevance', pageNumber = 1, note = '') {
        await this.viewResultsPageByUuid(uuid, sortBy, pageNumber);
        return this.fetchCurrentPageInfo(note);
    }

    /** 查看指定 UUID 的结果页，并可指定排序方式与页码
     * - uuid: 目标结果集 UUID
     * - sortBy: 结果页排序方式，默认 `relevance`
     * - pageNumber: 结果页页码，默认第 1 页
     */
    async viewResultsPageByUuid(uuid = '', sortBy = 'relevance', pageNumber = 1) {
        this.currentUuid = uuid;
        const href = `/wos/woscc/summary/${this.currentUuid}/${sortBy}/${pageNumber}`
        if (window.location.pathname !== href) {
            window.history.pushState({}, "", href);
            window.dispatchEvent(new Event("popstate"));
            await webFuncs.sleep(250);
            await webWait.waitForElementBySelector('div[data-ta="search-info"]', 50);
        }
    }

    /** 兼容旧接口：打开指定 uuid 结果页
     */
    async open(uuid = '', sortBy = 'relevance', page_number = 1) {
        return this.viewResultsPageByUuid(uuid, sortBy, page_number);
    }

    /** 查看指定 UUID 的分析结果页，等待分析结果容器渲染完成
     * - uuid: 目标结果集 UUID
     *
    */
    async viewAnalyzeResultsByUuid(uuid = '') {
        this.currentUuid = uuid;
        // 再跳转到 analyze-results 页面
        const href = `/wos/woscc/analyze-results/${this.currentUuid}`
        if (window.location.pathname !== href) {
            window.history.pushState({}, "", href);
            window.dispatchEvent(new Event("popstate"));
            await webFuncs.sleep(250);
            // 判断.analyze-container 的容器出现
            await webWait.waitForElementBySelector('.analyze-container', 50);
        }
    }

    /** 兼容旧接口：跳转到 analyze-results 页面
     */
    async analyze_results(uuid = '') {
        return this.viewAnalyzeResultsByUuid(uuid);
    }

    /** 查看指定 UUID 的引用报告页，等待 #snCriteria 元素渲染完成
    */
    async viewCitationReportByUuid(uuid = '') {
        this.currentUuid = uuid;
        // 再跳转到 analyze-results 页面
        const href = `/wos/woscc/citation-report/${this.currentUuid}`;
        if (window.location.pathname !== href) {
            window.history.pushState({}, "", href);
            window.dispatchEvent(new Event("popstate"));
            await webFuncs.sleep(250);
            //判断 #snCriteria 的元素出现
            await webWait.waitForElementBySelector('#snCriteria', 50);
        }
    }

    /** 兼容旧接口：跳转到 citation-report 页面
     */
    async citation_report(uuid = '') {
        return this.viewCitationReportByUuid(uuid);
    }

    /** 获取 refine 标签的映射
     */
    get refineLabels() {
        return {
            PY: 'See all Publication Years',
            DT: 'See all Document Types',
            DX2NG: 'See all Researcher Profiles',
            TASCA: 'See all Web of Science Categories',
            TMSO: 'See all Citation Topics Meso',
            TMIC: "See all Citation Topics Micro",
            SDG: "See all Sustainable Development Goals",
            EDN: "See all Web of Science Index",
            OG: 'See all Affiliations',
            DLM: "See all Affiliation with Department",
            SO: "See all Publication Titles",
            LA: "See all Languages",
            CU: 'See all Countries/Regions',
            PUBL: "See all Publishers",
            SJ: "See all Research Areas",
            FO: "See all Funding Agencies",
            CF: "See all Conference Titles",
        };
    }

    /** 兼容旧接口：refine 标签映射
     */
    get refine_typ() {
        return this.refineLabels;
    }

    /** 构造 refine 标签参数配置列表
     * - fields: refine 标签的字段名称列表，默认只包含 'OG'（机构名称）
     * - maxRows: 每个 refine 标签的最大行数，默认 100；'OG' 字段默认 300 行
     * - 返回值: 适用于 WOS refine 接口的参数对象数组
    */
    #refineParameters(fields = ['OG'], maxRows = [100]) {
        const s = [
            {
                // 'See all Publication Years'
                "Field": {
                    "Name": "PY",
                    "SortType": "Field",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // 'See all Document Types'
                "Field": {
                    "Name": "DT",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // 'See all Researcher Profiles'
                "Field": {
                    "Name": "DX2NG",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // 'See all Web of Science Categories'
                "Field": {
                    "Name": "TASCA",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // 'See all Citation Topics Meso'
                "Field": {
                    "Name": "TMSO",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // "See all Citation Topics Micro"
                "Field": {
                    "Name": "TMIC",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                //"See all Sustainable Development Goals"
                "Field": {
                    "Name": "SDG",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // "See all Web of Science Index"
                "Field": {
                    "Name": "EDN",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // 'See all Affiliations'
                "Field": {
                    "Name": "OG",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 300,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // "See all Affiliation with Department"
                "Field": {
                    "Name": "DLM",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 300,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // "See all Publication Titles"
                "Field": {
                    "Name": "SO",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // "See all Languages"
                "Field": {
                    "Name": "LA",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // 'See all Countries/Regions'
                "Field": {
                    "Name": "CU",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // "See all Publishers"
                "Field": {
                    "Name": "PUBL",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // "See all Research Areas"
                "Field": {
                    "Name": "SJ",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // "See all Open Access Journals"
                "Field": {
                    "Name": "OAJ",
                    "SortType": "IS",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // Filter by Marked List 
                "Field": {
                    "Name": "LIST",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // Funding Agencies 
                "Field": {
                    "Name": "FO",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // Conference Titles 
                "Field": {
                    "Name": "CF",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // Group Authors
                "Field": {
                    "Name": "GP",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                //  Book Series Titles 
                "Field": {
                    "Name": "SE",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            },
            {
                // Editors
                "Field": {
                    "Name": "ED",
                    "SortType": "Value",
                    "Threshold": 1,
                    "MaxRows": 100,
                    "Sort": "D",
                    "Language": "en"
                }
            }
        ]
        if (!Array.isArray(fields)) {
            // 返回所有默认参数集
            return s
        }
        const res = [];
        for (const f of fields) {
            const item = s.find(i => i.Field.Name === f);
            if (item) {
                if (Array.isArray(maxRows)) {
                    const idx = fields.indexOf(f);
                    if (idx >= 0 && maxRows[idx]) {
                        item.Field.MaxRows = maxRows[idx];
                    }
                }
                res.push(item);
            }
        }
        return res;
    }

    /** 构造 refine 接口请求体
     * - uuid: 目标结果集 UUID
     * - fields: refine 标签的字段名称列表
     * - maxRows: 每个 refine 标签的最大行数配置
     * - 返回值: refine 接口所需的请求体对象
     */
    #buildRefineRequestBody(uuid, fields = 'all', maxRows = [100]) {
        return {
            retrieve: {
                Options: {
                    DataFormat: "Map",
                    ReturnType: "List",
                    View: "SiloSummaryAbstractSubset"
                },
                FirstRecord: 1,
                AnalyzeParameters: this.#refineParameters(fields, maxRows),
                Count: 0
            },
            id: uuid
        };
    }

    /** 按指定 UUID 请求 refine 数据
     * - uuid: 目标结果集 UUID
     * - fields: refine 标签的字段名称列表
     * - maxRows: 每个 refine 标签的最大行数配置
     * - 返回值: 成功时返回 refine 接口 JSON，失败时返回 null
     */
    async #fetchRefineDataByUuid(uuid, fields = 'all', maxRows = [100]) {
        if (!this.#isValidUuid(uuid)) {
            console.warn('Failed to validate UUID for refine request.');
            return null;
        }

        this.currentUuid = uuid;
        const requestBody = this.#buildRefineRequestBody(uuid, fields, maxRows);
        try {
            const response = await fetch('https://www.webofscience.com/api/esti/SearchEngine/retrieve', {
                method: 'POST',
                headers: {
                    'accept': 'application/json',
                    'accept-language': 'en,zh-TW;q=0.9,zh;q=0.8',
                    'cache-control': 'no-cache',
                    'content-type': 'text/plain;charset=UTF-8',
                    'origin': 'https://www.webofscience.com',
                    'pragma': 'no-cache',
                    'priority': 'u=1, i',
                    'referer': window.location.href,
                    'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
                    'sec-ch-ua-arch': '"arm"',
                    'sec-ch-ua-bitness': '"64"',
                    'sec-ch-ua-full-version': '"142.0.7444.176"',
                    'sec-ch-ua-full-version-list': '"Chromium";v="142.0.7444.176", "Google Chrome";v="142.0.7444.176", "Not_A Brand";v="99.0.0.0"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-model': '""',
                    'sec-ch-ua-platform': '"macOS"',
                    'sec-ch-ua-platform-version': '"26.2.0"',
                    'sec-fetch-dest': 'empty',
                    'sec-fetch-mode': 'cors',
                    'sec-fetch-site': 'same-origin',
                    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
                    ...(wosInfo.sid ? { 'x-1p-wos-sid': wosInfo.sid } : {}),
                    'cookie': window.document.cookie
                },
                body: JSON.stringify(requestBody)
            });
            if (!response.ok) {
                console.error(`Request failed for uuid: ${this.currentUuid} \n Status: ${response.status}`);
                return null;
            }
            return await response.json();
        } catch (error) {
            console.error('Error during refine fetch:', error);
            return null;
        }
    }

    /** 将 refine 接口返回的数据并入 UUID 缓存
     * - refineJson: refine 接口返回的 JSON 对象
     * - 返回值: 成功并入时返回 QueryID；数据结构不完整时返回 null
     */
    #mergeRefineDataIntoCache(refineJson) {
        const queryId = refineJson?.QueryResult?.QueryID;
        const analyzeResults = refineJson?.Data?.AnalyzeResults || {};
        if (!queryId) {
            return null;
        }

        for (const field of Object.values(analyzeResults)) {
            if (this.db[queryId] && this.db[queryId][field.Name]) {
                delete this.db[queryId][field.Name];
            }
            this.mergeIntoCache(queryId, { [field.Name]: field.Values });
        }
        return queryId;
    }

    /** 按指定 UUID 请求 refine 数据，并将结果写入本地缓存
     * - uuid: 目标结果集 UUID
     * - fields: refine 标签的字段名称列表，默认 `'all'`
     * - maxRows: 每个 refine 标签的最大行数配置
     * - 说明: 如果当前网址字符串不包含目标 uuid，会先打开该 uuid 的结果页
     * - 返回值: 成功时返回 refine 接口 JSON，失败时返回 null
     */
    async collectRefineDataByUuid(uuid, fields = 'all', maxRows = [100]) {
        if (!this.#isValidUuid(uuid)) {
            console.warn('Failed to validate UUID for refine data collection.');
            return null;
        }
        // 如果当前页面 URL 不包含目标 UUID，先跳转到该 UUID 的结果页
        if (!window.location.href.includes(uuid)) {
            await this.viewResultsPageByUuid(uuid);
        }

        // 请求 refine 数据并写入缓存
        const refineJson = await this.#fetchRefineDataByUuid(uuid, fields, maxRows);
        if (!refineJson) {
            return null;
        }

        this.#mergeRefineDataIntoCache(refineJson);
        return refineJson;
    }

    /** 兼容旧接口：基于当前页 uuid 采集 refine 数据
     */
    async current_page_refine(fields = 'all', maxRows = [100]) {
        const uuid = this.#extractUuid(window.location.href);
        if (!this.#isValidUuid(uuid)) {
            console.warn('Failed to extract UUID from current page URL.');
            return null;
        }
        this.currentUuid = uuid;
        return this.collectRefineDataByUuid(uuid, fields, maxRows);
    }

    /** 增量收集指定 UUID 指定页码中的 WOS ID 列表，并写入缓存
     * - uuid: 目标结果集 UUID
     * - pages: 目标页码；可传 `'all'`、单个页码或页码数组，默认 `'all'`
     * - sortBy: 结果页排序方式，默认 `relevance`
     * - 返回值: 成功时返回已缓存的 WOS ID 列表；参数非法或无有效页码时返回 null
     */
    async collectWosIdsByUuidPages(uuid, pages = 2, sortBy = 'relevance') {
        if (!this.#isValidUuid(uuid)) {
            console.warn('Failed to validate UUID for collecting WOS IDs.');
            return null;
        }

        const targetPath = `/wos/woscc/summary/${uuid}/${sortBy}/1`;
        const isTargetResultsFirstPage = window.location.href.includes(uuid)
            && window.location.href.includes(`/${sortBy}/`)
            && window.location.pathname === targetPath;

        if (!isTargetResultsFirstPage) {
            await this.viewResultsPageByUuid(uuid, sortBy, 1);
        }

        const max_num = document.querySelector('.end-page.ng-star-inserted')?.textContent?.trim() || '1';
        const maxPage = parseInt(max_num, 10);

        let targetPages = [];
        if (pages === 'all' || pages === null || pages === undefined) {
            targetPages = Array.from({ length: maxPage }, (_, index) => index + 1);
        } else if (Number.isInteger(pages) && pages > 0) {
            targetPages = [pages];
        } else if (Array.isArray(pages)) {
            targetPages = [...new Set(
                pages
                    .map((page) => Number(page))
                    .filter((page) => Number.isInteger(page) && page > 0 && page <= maxPage)
            )].sort((a, b) => a - b);
        }

        if (targetPages.length === 0) {
            console.warn('No valid target pages provided for collecting WOS IDs.');
            return null;
        }

        for (const pageNumber of targetPages) {
            await this.goToPage(pageNumber);
            await this.collectWosIdsFromCurrentUuidPage();
        }
        return this.db[uuid]?.page_wosids || null;
    }

    /** 兼容旧接口：基于当前页 uuid 抓取全部页的 WOS ID
     */
    async current_page_all_wosids() {
        const uuid = this.#extractUuid(window.location.href);
        if (!this.#isValidUuid(uuid)) {
            console.warn('Failed to extract UUID from current page URL.');
            return null;
        }
        this.currentUuid = uuid;
        return this.collectWosIdsByUuidPages(uuid, 'all');
    }

    /** 收集当前 UUID 结果页(1页)中的 WOS ID 列表，并写入缓存
     */
    async collectWosIdsFromCurrentUuidPage() {
        let uuid = this.#extractUuid(window.location.href);
        // 更新 uuid 全局值
        if (uuid) {
            this.currentUuid = uuid;
        } else {
            console.warn('Failed to extract UUID from current page URL.');
            return null;
        }

        await webFuncs.autoScroll();
        const links = document.querySelectorAll('.summary-record');
        let res = [];
        links.forEach((item) => {
            let href = item.querySelector('app-summary-title a')?.getAttribute('href');
            if (href) {
                href = href.split('/').pop();
            } else {
                return;
            }
            const citations_count = item.querySelector('a[data-ta="stat-number-citation-related-count"]')?.textContent?.trim() || '0';
            const ref_count = item.querySelector('a[data-ta="stat-number-references-count"]')?.textContent?.trim() || '0';
            // related count
            const related_count = item.querySelector('a[data-ta="sharedRef-records-link"]')?.textContent?.trim() || '0';

            res.push({
                wosid: href,
                citations_count,
                related_count,
                ref_count
            });
        });
        this.mergeIntoCache(uuid, { page_wosids: res });
        return res;
    }

    /** 兼容旧接口：抓取当前页 WOS ID
     */
    async current_page_wosids() {
        return this.collectWosIdsFromCurrentUuidPage();
    }

    /** 在uuid 页面中,通过修改 url 的方式跳转到指定页码,并等待页面加载完成
     */
    async goToPage(n = 1) {
        const max_num = document.querySelector('.end-page.ng-star-inserted')?.textContent?.trim() || '1';
        const maxPage = Number.parseInt(max_num, 10) || 1;
        let pageNumber = Number.parseInt(n, 10) || 1;
        if (pageNumber > maxPage) {
            pageNumber = maxPage;
            console.log(`exceeded max page number, adjusted to max page number: ${maxPage}`);
        }
        if (pageNumber < 1) {
            pageNumber = 1;
        }
        // 判断当前是否已经在 uuid 页面
        if (window.location.pathname.startsWith("/wos/woscc/summary/")) {
            const href = window.location.pathname.split("/").slice(0, -1).concat(pageNumber).join("/")
            window.history.pushState({}, "", href);
            window.dispatchEvent(new Event("popstate"));
            await webWait.waitForElementBySelector("app-summary-title", 50)
            return true;
        }
        return false;
    }

    // 通过点击下一页按钮的方式跳转到下一页，并等待页面加载完成
    async goToNextPage() {
        const btn = document.querySelector('button[cdxanalyticscategory="wos_navigation_next_page"]');
        if (!btn) return;
        btn.click();
        await webWait.waitForElementBySelector("app-summary-title", 50)
    }

    // 通过点击上一页按钮的方式跳转到上一页，并等待页面加载完成
    async goToPreviousPage() {
        const btn = document.querySelector('button[cdxanalyticscategory="wos_navigation_previous_page"]');
        if (!btn) return;
        btn.click();
        await webWait.waitForElementBySelector("app-summary-title", 50)
    }

    /** 按记录范围请求指定 UUID 的 WOS 导出文本
     * - uuid: 目标结果集 UUID
     * - markFrom: 起始记录序号
     * - markTo: 结束记录序号
     * - fieldList: 导出字段类型，默认 `fullRecord`
     * - 返回值: 成功时返回原始导出文本，失败时返回 null
     */
    async #fetchWosdataTxtByRange(uuid = '', markFrom = 1, markTo = 100, fieldList = 'fullRecord', options = {}) {
        if (!this.#isValidUuid(uuid)) {
            console.warn('Failed to validate UUID for export request.');
            return null;
        }

        const requestBody = {
            action: "saveToFieldTagged",
            colName: "WOS",
            displayTimesCited: "true",
            displayUsageInfo: "true",
            displayCitedRefs: "true",
            filters: fieldList,
            fileOpt: "othersoftware",
            locale: "en_US",
            parentQid: uuid,
            sortBy: options.sortBy || "relevance",
            product: "UA",
            markFrom: `${markFrom}`,
            markTo: `${markTo}`,
            view: "summary",
            isRefQuery: "false",
        };

        const sid = wosInfo.sid;
        const headers = {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            ...(sid ? { 'x-1p-wos-sid': sid } : {}),
        };

        try {
            const response = await fetch(`${window.location.origin}/api/wosnx/indic/export/saveToFile`, {
                method: 'POST',
                credentials: 'same-origin',
                headers,
                body: JSON.stringify(requestBody)
            });

            if (!response.ok) {
                console.error(`request failed:uuid: ${uuid} \n status code: ${response.status}`);
                return null;
            }
            const text = await response.text();
            console.log(`fetch records from ${markFrom} to ${markTo} for UUID: ${uuid}`);
            return text;
        } catch (error) {
            console.error(`request error:uuid: ${uuid}`, error);
            return null;
        }
    }

    /** 按记录范围请求指定 UUID 的 BibTeX 文本
     * - uuid: 目标结果集 UUID
     * - markFrom: 起始记录序号
     * - markTo: 结束记录序号
     * - filters: BibTeX 导出字段类型
     * - 返回值: 成功时返回 BibTeX 文本，失败时返回 null
     */
    async #fetchBibtexByRange(uuid = '', markFrom = 1, markTo = 100, filters = 'authorTitleSource', options = {}) {
        if (!this.#isValidUuid(uuid)) {
            console.warn('Failed to validate UUID for bib export request.');
            return null;
        }

        const requestBody = {
            parentQid: uuid,
            sortBy: options.sortBy || 'relevance',
            displayTimesCited: 'true',
            displayCitedRefs: 'true',
            product: 'UA',
            colName: 'WOS',
            displayUsageInfo: 'true',
            fileOpt: 'othersoftware',
            action: 'saveToBibtex',
            markFrom: `${markFrom}`,
            markTo: `${markTo}`,
            view: 'summary',
            isRefQuery: 'false',
            locale: 'en_US',
            filters,
        };

        const sid = wosInfo.sid;
        const headers = {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            ...(sid ? { 'x-1p-wos-sid': sid } : {}),
        };

        try {
            const response = await fetch(`${window.location.origin}/api/wosnx/indic/export/saveToFile`, {
                method: 'POST',
                credentials: 'same-origin',
                headers,
                body: JSON.stringify(requestBody),
            });

            if (!response.ok) {
                console.error(`bib export failed:uuid: ${uuid} \n status code: ${response.status}`);
                return null;
            }
            const text = await response.text();
            console.log(`fetch bib records from ${markFrom} to ${markTo} for UUID: ${uuid}`);
            return text;
        } catch (error) {
            console.error(`bib export error:uuid: ${uuid}`, error);
            return null;
        }
    }

    /** 按批次导出指定 UUID 的记录文本，并将每一批交给调用方处理
     * - uuid: 目标结果集 UUID
     * - markFrom: 起始记录序号
     * - markTo: 结束记录序号，传 `0` 表示导出到最后一条
     * - batchSize: 每批导出记录数
     * - fieldList: 导出字段类型
     * - onProgress: 进度回调
     * - onBatch: 每批文本的处理函数，参数为 `(text, batchStart, batchEnd, currentUuid)`
     * - 返回值: 成功时返回批处理概要信息，失败时返回 null
     */
    async #runBatchExportByUuid(uuid, {
        markFrom = 1,
        markTo = 0,
        batchSize = 200,
        fieldList = 'fullRecord',
        sortBy = 'relevance',
        onProgress = null,
        onBatch = null,
        fetchBatch = null,
    } = {}) {
        const emitProgress = (payload = {}) => {
            if (typeof onProgress !== 'function') return;
            try {
                onProgress(payload);
            } catch (error) {
                console.warn('[WOS] batch export progress callback failed:', error);
            }
        };

        const res = await this.#fetchPageInfoByUuid(uuid);
        if (!res || res.status === 'failed') {
            const message = 'Failed to retrieve UUID information.';
            console.error(message);
            emitProgress({ phase: 'error', message });
            return null;
        }
        this.currentUuid = uuid;

        const maxRefCount = Number.parseInt(res.ref_count, 10);
        if (markTo === 0) {
            markTo = maxRefCount;
        } else if (markTo > maxRefCount) {
            markTo = maxRefCount;
        }

        console.log(`Starting download task: \nUUID: ${this.currentUuid} \nRecords: ${markFrom} to ${markTo}, Type: ${fieldList} \nbatch size: ${batchSize}`);

        let current = markFrom;
        const totalRecords = Math.max(markTo - markFrom + 1, 0);
        const totalBatches = totalRecords > 0 ? Math.ceil(totalRecords / batchSize) : 0;
        let completedBatches = 0;

        emitProgress({
            phase: 'start',
            uuid: this.currentUuid,
            markFrom,
            markTo,
            fieldList,
            batchSize,
            totalRecords,
            totalBatches,
            completedBatches,
        });

        while (current <= markTo) {
            const batchEnd = Math.min(current + batchSize - 1, markTo);
            const fetchBatchFn = typeof fetchBatch === 'function'
                ? fetchBatch
                : (currentUuid, batchStart, batchStop, currentFieldList) => this.#fetchWosdataTxtByRange(
                    currentUuid,
                    batchStart,
                    batchStop,
                    currentFieldList,
                    { sortBy },
                );
            const text = await fetchBatchFn(uuid, current, batchEnd, fieldList);
            if (text === null) {
                const message = `Export request failed for records ${current}-${batchEnd}.`;
                console.error(message);
                emitProgress({
                    phase: 'error',
                    uuid: this.currentUuid,
                    message,
                    current,
                    batchEnd,
                    completedBatches,
                    totalBatches,
                });
                throw new Error(message);
            }

            const batchMeta = typeof onBatch === 'function'
                ? await onBatch(text, current, batchEnd, this.currentUuid)
                : {};

            completedBatches += 1;
            emitProgress({
                phase: 'batch',
                uuid: this.currentUuid,
                fieldList,
                batchSize,
                totalRecords,
                totalBatches,
                completedBatches,
                current,
                batchEnd,
                ...(batchMeta && typeof batchMeta === 'object' ? batchMeta : {}),
            });
            current = batchEnd + 1;
        }

        emitProgress({
            phase: 'complete',
            uuid: this.currentUuid,
            fieldList,
            batchSize,
            totalRecords,
            totalBatches,
            completedBatches,
        });

        return {
            status: 'completed',
            uuid: this.currentUuid,
            totalRecords,
            totalBatches,
            completedBatches,
        };
    }

    /** 分批请求指定 UUID 的导出文本，并逐批保存为本地 txt 文件
     */
    async saveTxtByUuidInBatches(uuid, markFrom = 1, markTo = 0, batchSize = 200, onProgress = null) {
        return this.#runBatchExportByUuid(uuid, {
            markFrom,
            markTo,
            batchSize,
            fieldList: 'fullRecord',
            sortBy: 'relevance',
            onProgress,
            onBatch: async (text, batchStart, batchEnd, currentUuid) => {
                const filename = `${currentUuid}_${batchStart}_${batchEnd}`;
                await webFuncs.saveTextAsFile(text, filename);
                return { filename: `${filename}.txt` };
            },
        });
    }

    /** 分批请求指定 UUID 的导出文本，并将每一批文本保存在内存数组中返回
     */
    async fetchTxtsByUuidInBatches(uuid, markFrom = 1, markTo = 0, batchSize = 200, onProgress = null) {
        const resultArray = [];
        const summary = await this.#runBatchExportByUuid(uuid, {
            markFrom,
            markTo,
            batchSize,
            fieldList: 'fullRecord',
            onProgress,
            onBatch: async (text) => {
                resultArray.push(text);
                return { resultLength: resultArray.length };
            },
        });
        if (!summary) {
            return null;
        }
        return {
            ...summary,
            data: resultArray,
        };
    }

    /** 分批请求指定 UUID 的导出文本，并按 CLI 稳定结构返回每批内容
     * - options: { uuid, markFrom, markTo, batchSize, sortBy, onProgress }
     */
    async fetchTxtBatches(options = {}) {
        const {
            uuid = '',
            markFrom = 1,
            markTo = 0,
            batchSize = 200,
            sortBy = 'relevance',
            onProgress = null,
        } = options || {};
        const batches = [];
        const summary = await this.#runBatchExportByUuid(uuid, {
            markFrom,
            markTo,
            batchSize,
            fieldList: 'fullRecord',
            sortBy,
            onProgress,
            onBatch: async (text, batchStart, batchEnd, currentUuid) => {
                batches.push({
                    uuid: currentUuid,
                    markFrom: batchStart,
                    markTo: batchEnd,
                    text,
                });
                return { resultLength: batches.length };
            },
        });
        if (!summary) return null;
        return {
            ...summary,
            batches,
        };
    }

    /** 分批请求指定 UUID 的 BibTeX 文本，并逐批保存为本地 bib 文件
     */
    async saveBibByUuidInBatches(uuid, markFrom = 1, markTo = 0, batchSize = 200, onProgress = null, filters = 'authorTitleSource') {
        return this.#runBatchExportByUuid(uuid, {
            markFrom,
            markTo,
            batchSize,
            fieldList: filters,
            sortBy: 'relevance',
            onProgress,
            onBatch: async (text, batchStart, batchEnd, currentUuid) => {
                const filename = `${currentUuid}_${batchStart}_${batchEnd}`;
                await webFuncs.saveTextAsFile(text, filename, 'bib');
                return { filename: `${filename}.bib` };
            },
            fetchBatch: (currentUuid, batchStart, batchEnd, currentFieldList) => this.#fetchBibtexByRange(currentUuid, batchStart, batchEnd, currentFieldList),
        });
    }

    /** 分批请求指定 UUID 的 BibTeX 文本，并将每一批保存在内存数组中返回
     */
    async fetchBibsByUuidInBatches(uuid, markFrom = 1, markTo = 0, batchSize = 200, onProgress = null, filters = 'authorTitleSource') {
        const resultArray = [];
        const summary = await this.#runBatchExportByUuid(uuid, {
            markFrom,
            markTo,
            batchSize,
            fieldList: filters,
            onProgress,
            onBatch: async (text) => {
                resultArray.push(text);
                return { resultLength: resultArray.length };
            },
            fetchBatch: (currentUuid, batchStart, batchEnd, currentFieldList) => this.#fetchBibtexByRange(currentUuid, batchStart, batchEnd, currentFieldList),
        });
        if (!summary) {
            return null;
        }
        return {
            ...summary,
            data: resultArray,
        };
    }

    /** 分批请求指定 UUID 的 BibTeX 文本，并按 CLI 稳定结构返回每批内容
     * - options: { uuid, markFrom, markTo, batchSize, sortBy, filters, onProgress }
     */
    async fetchBibBatches(options = {}) {
        const {
            uuid = '',
            markFrom = 1,
            markTo = 0,
            batchSize = 200,
            sortBy = 'relevance',
            filters = 'authorTitleSource',
            onProgress = null,
        } = options || {};
        const batches = [];
        const summary = await this.#runBatchExportByUuid(uuid, {
            markFrom,
            markTo,
            batchSize,
            fieldList: filters,
            sortBy,
            onProgress,
            onBatch: async (text, batchStart, batchEnd, currentUuid) => {
                batches.push({
                    uuid: currentUuid,
                    markFrom: batchStart,
                    markTo: batchEnd,
                    text,
                });
                return { resultLength: batches.length };
            },
            fetchBatch: (currentUuid, batchStart, batchEnd, currentFieldList) => this.#fetchBibtexByRange(currentUuid, batchStart, batchEnd, currentFieldList, { sortBy }),
        });
        if (!summary) return null;
        return {
            ...summary,
            batches,
        };
    }

    /** 兼容旧接口：基于当前页 uuid，分批导出 txt 到本地
     */
    async export_batchSize_toTxt(markFrom = 1, markTo = 0, batchSize = 200, onProgress = null) {
        const res = await this.fetchCurrentPageInfo();
        if (!res?.uuid) {
            console.error('Failed to retrieve UUID information.');
            return null;
        }
        return this.saveTxtByUuidInBatches(res.uuid, markFrom, markTo, batchSize, onProgress);
    }

    /** 兼容旧接口：基于当前页 uuid，分批导出 bib 到本地
     */
    async export_batchSize_toBib(markFrom = 1, markTo = 0, batchSize = 200, onProgress = null, filters = 'authorTitleSource') {
        const res = await this.fetchCurrentPageInfo();
        if (!res?.uuid) {
            console.error('Failed to retrieve UUID information.');
            return null;
        }
        return this.saveBibByUuidInBatches(res.uuid, markFrom, markTo, batchSize, onProgress, filters);
    }

    /** 兼容旧接口：基于当前页 uuid，分批请求 txt 并以内存数组返回
     */
    async export_batchSize(markFrom = 1, markTo = 0, batchSize = 200, onProgress = null) {
        const res = await this.fetchCurrentPageInfo();
        if (!res?.uuid) {
            console.error('Failed to retrieve UUID information.');
            return null;
        }
        return this.fetchTxtsByUuidInBatches(res.uuid, markFrom, markTo, batchSize, onProgress);
    }

    /** 兼容旧接口：保留旧名称，等价于 export_batchSize
     */
    async export_pre_num(markFrom = 1, markTo = 0, batchSize = 200, onProgress = null) {
        return this.export_batchSize(markFrom, markTo, batchSize, onProgress);
    }

    /** 兼容旧接口：导出前 200 条
     */
    async export_pre_200(markFrom = 1, markTo = 0, batchSize = 200, onProgress = null) {
        return this.export_pre_num(markFrom, markTo, batchSize, onProgress);
    }


    /** (内部方法) 前端操作的方式,下载指定范围的文献记录,
     */
    async #exportTxtByOverlayUi(from = 1, to = 0, recordContent = 'Full Record') {
        const href = `${window.location.pathname}(overlay:export/exc)`;
        const targetHref = new URL(href, window.location.origin).href;
        if (window.location.href !== targetHref) {
            window.history.pushState({}, "", targetHref);
            window.dispatchEvent(new Event("popstate"));
        }

        const exportButton = await webWait.waitForElementBySelector("#exportButton", 50);
        if (!exportButton) {
            throw new Error('Failed to locate export button in overlay.');
        }

        const rangeRadio = document.querySelector('#radio3-input');
        if (!rangeRadio) {
            throw new Error('Failed to locate range export radio button.');
        }
        rangeRadio.click();

        const fromInput = await webWait.waitForElementBySelector('[id*="mat-input"][name="markFrom"]', 50);
        const toInput = await webWait.waitForElementBySelector('[id*="mat-input"][name="markTo"]', 50);
        if (!fromInput || !toInput) {
            throw new Error('Failed to locate export range input fields.');
        }

        //处理设置 开始值
        fromInput.value = String(from);
        fromInput.dispatchEvent(new Event('input', { bubbles: true }));
        //处理设置 结束值
        toInput.value = String(to);
        toInput.dispatchEvent(new Event('input', { bubbles: true }));

        const emitMouseClick = (el) => {
            if (!el) {
                return false;
            }
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return true;
        };

        const recordTypeDropdown = document.querySelector('.margin-top-5.ng-star-inserted > .mat-mdc-tooltip-trigger.dropdown.mat-mdc-tooltip-disabled.ng-star-inserted');
        if (!emitMouseClick(recordTypeDropdown)) {
            throw new Error('Failed to locate export record type dropdown.');
        }
        await webFuncs.sleep(100);

        const recordTypeOption = document.querySelector(`.options.options-menu div[title="${recordContent}"]`);
        if (!emitMouseClick(recordTypeOption)) {
            throw new Error(`Failed to locate export option: ${recordContent}.`);
        }
        await webFuncs.sleep(100);

        exportButton.click();
        const disappeared = await webWait.waitForElementToDisappear("#exportButton", 100);
        if (!disappeared) {
            throw new Error('Export overlay did not complete after clicking export button.');
        }

        return {
            from,
            to,
            recordContent,
            status: 'success',
        };
    }

    /** 基于当前页 uuid，通过前端操作的方式，分批下载指定范围的文献记录，并保存为 txt 文件
     */
    async saveTxtByUuidViaOverlayUi(uuid, markFrom = 1, markTo = 0, filter = 'FULL') {
        const res = await this.#fetchPageInfoByUuid(uuid);
        if (!res) {
            console.error('Failed to retrieve UUID information.');
            return null;
        }
        this.currentUuid = uuid;

        if (!res || res.status === 'failed') {
            console.error('Failed to retrieve UUID information.');
            return null;
        }

        const max_ref_count = parseInt(res.ref_count);
        // 再跳转到 export 页面
        if (markTo == 0) {
            markTo = max_ref_count;
        } else if (markTo > max_ref_count) {
            markTo = max_ref_count;
        }

        const typ = {
            "ATS": 'Author, Title, Source',
            "ATSA": 'Author, Title, Source, Abstract',
            'FULL': 'Full Record',
            'UT': "ACCESSION_NUM"
        }
        const recordContent = typ[filter] || 'Full Record';

        console.log(`Starting download task: \nUUID: ${this.currentUuid} \nRecords: ${markFrom} to ${markTo}, recordContent: ${recordContent} \nbatch size: 500`);
        // 分批下载     
        const batchSize = 500;
        let current = markFrom;
        while (current <= markTo) {
            const batchEnd = Math.min(current + batchSize - 1, markTo);
            try {
                await this.#exportTxtByOverlayUi(
                    current,
                    batchEnd,
                    recordContent
                );
            } catch (error) {
                const message = `Overlay export failed for records ${current}-${batchEnd}.`;
                console.error(message, error);
                throw new Error(message);
            }
            current = batchEnd + 1;
        }

        return {
            status: 'completed',
            uuid: this.currentUuid,
            markFrom,
            markTo,
            filter,
        };
    }

}
const wosUuidStore = WosUuidStore.getInstance();
const asy_uuid = wosUuidStore;



















































































class WosJcr {
    static instance = null;

    static getInstance() {
        return WosJcr.instance || new WosJcr();
    }

    constructor() {
        if (WosJcr.instance) return WosJcr.instance;
        WosJcr.instance = this;
    }

    /** 将 cookie 字符串解析为键值对象
     */
    #parseCookieString(cookieStr) {
        const obj = {};
        cookieStr.split(";").forEach(pair => {
            let [key, value] = pair.split("=");
            if (!key) return;

            key = key.trim();
            value = (value || "").trim();

            obj[key] = value;
        });
        return obj;
    }

    /** 请求一页 JCR 期刊结果
     * - start: 起始记录序号
     * - count: 每次请求数量，默认 600
     * - jcrYear: JCR 年份，默认 2024
     * - 返回值: 成功时返回 JCR 接口 JSON，失败时返回 null
     */
    async fetchJournalPage(start = 1, count = 600, jcrYear = 2024) {
        const url = 'https://jcr.clarivate.com/api/jcr3/bwjournal/v1/search-result';

        const pssid = this.#parseCookieString(window.document.cookie).PSSID;
        if (!pssid) {
            console.error("PSSID cookie not found.");
            return null;
        }

        const requestBody = {
            journalFilterParameters: {
                query: "",
                journals: [],
                categories: [],
                publishers: [],
                countryRegions: [],
                citationIndexes: ["SCIE", "SSCI", "AHCI", "ESCI"],
                jcrYear,
                categorySchema: "WOS",
                openAccess: "N",
                jifQuartiles: [],
                jifRanges: [],
                jifNA: false,
                jifPercentileRanges: [],
                jciRanges: [],
                oaRanges: [],
                issnJ20s: []
            },
            retrievalParameters: {
                start,
                count,
                sortBy: "jci",
                sortOrder: "DESC"
            }
        };

        const res = await fetch(url, {
            method: "POST",
            headers: {
                "accept": "application/json, text/plain, */*",
                "content-type": "application/json",
                "origin": "https://jcr.clarivate.com",
                "referer": "https://jcr.clarivate.com/jcr/browse-journals",
                "user-agent": navigator.userAgent,
                "x-1p-inc-sid": pssid
            },
            body: JSON.stringify(requestBody)
        });

        if (!res.ok) {
            console.error(`JCR request failed. Status: ${res.status}`);
            return null;
        }

        const data = await res.json();
        console.log("JCR fetch result: ", data?.data?.length || 0, "records");
        return data;
    }

    /** 获取 JCR 结果总记录数
     * - jcrYear: JCR 年份，默认 2024
     * - 返回值: 成功时返回总记录数，失败时返回 0
     */
    async fetchJournalTotalCount(jcrYear = 2024) {
        const initialRes = await this.fetchJournalPage(1, 600, jcrYear);
        if (!initialRes || !initialRes.totalCount) {
            console.error("Failed to fetch total count.");
            return 0;
        }
        return initialRes.totalCount;
    }

    /** 分批抓取全部 JCR 结果，并按批次保存为本地 JSON 文件
     * - totalCount: 记录总数；传 0 时会自动请求总数
     * - jcrYear: JCR 年份，默认 2024
     * - batchSize: 每批请求数量，默认 600
     * - 返回值: 成功时返回 true，失败时返回 false
     */
    async saveAllJournalJson(totalCount = 0, jcrYear = 2024, batchSize = 600) {
        if (totalCount === 0) {
            totalCount = await this.fetchJournalTotalCount(jcrYear);
            if (totalCount === 0) {
                console.error("No records to fetch.");
                return false;
            }
        }

        for (let start = 1; start <= totalCount; start += batchSize) {
            const res = await this.fetchJournalPage(start, batchSize, jcrYear);
            await webFuncs.sleep(10000); // 避免请求过快
            if (res) {
                const batchEnd = Math.min(start + batchSize - 1, totalCount);
                webFuncs.saveJsonToFile(res.data, `JCR_${start}_${batchEnd}`);
            }
        }
        return true;
    }

    /** 选择包含 JCR JSON 文件的文件夹，并将其合并导出为 CSV
    */
    mergeJsonFilesToCsv() {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.multiple = true;

        input.onchange = async (e) => {
            const files = Array.from(e.target.files || []);
            const jsonFiles = files.filter(f => f.name.toLowerCase().startsWith('jcr_') && f.name.toLowerCase().endsWith('.json'));

            if (jsonFiles.length === 0) {
                alert('No JSON files found in the selected folder');
                return;
            }

            console.log(`Found ${jsonFiles.length} JSON files`);
            console.log('Processing files... (large output suppressed)');
            const readFileAsText = (file) => {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = (err) => reject(err);
                    reader.readAsText(file, 'utf-8');
                });
            };

            const allRows = [];
            const allKeys = new Set();

            // ---- 核心：将一个对象展开为多行（针对数组字段） ----
            function expandObjectToRows(obj, extra = {}) {
                // 基础对象 + 文件名等额外信息
                const base = { ...extra, ...obj };

                // 收集需要展开的 “数组字段”（数组里是对象）
                const arrayObjectKeys = [];
                for (const [k, v] of Object.entries(base)) {
                    if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object' && v[0] !== null) {
                        arrayObjectKeys.push(k);
                    }
                }

                // 没有数组对象字段，就直接扁平化成一行
                if (arrayObjectKeys.length === 0) {
                    return [flattenObject(base)];
                }

                // 有数组对象字段：做笛卡尔展开
                // 先把这些字段从 base 里删掉，避免重复
                const baseWithoutArrays = { ...base };
                arrayObjectKeys.forEach(k => delete baseWithoutArrays[k]);

                // rows 从一个“只含基础字段”的对象开始
                let rows = [baseWithoutArrays];

                // 依次展开每个数组字段
                for (const key of arrayObjectKeys) {
                    const arr = obj[key];
                    const newRows = [];
                    for (const row of rows) {
                        for (const item of arr) {
                            // 每个 item 可能还有嵌套，这里先简单合并，后面 flattenObject 再递归扁平
                            newRows.push({ ...row, [key]: item });
                        }
                    }
                    rows = newRows;
                }

                // 把每个 row 做一次扁平化
                return rows.map(r => flattenObject(r));
            }

            // ---- 扁平化对象：把嵌套对象变成 a.b.c 这种 key ----
            function flattenObject(obj, prefix = '', res = {}) {
                for (const [key, value] of Object.entries(obj)) {
                    const newKey = prefix ? `${prefix}.${key}` : key;

                    if (value === null || value === undefined) {
                        res[newKey] = '';
                    } else if (Array.isArray(value)) {
                        // 数组：如果是对象数组，本来应该在 expand 阶段处理，这里兜底用 JSON
                        if (value.length > 0 && typeof value[0] === 'object') {
                            res[newKey] = JSON.stringify(value);
                        } else {
                            // 普通值数组，用 ; 拼接
                            res[newKey] = value.join(';');
                        }
                    } else if (typeof value === 'object') {
                        // 嵌套对象，递归展开
                        flattenObject(value, newKey, res);
                    } else {
                        res[newKey] = value;
                    }
                }
                return res;
            }

            // ---- 逐个文件处理 ----
            for (const file of jsonFiles) {
                try {
                    const text = await readFileAsText(file);
                    let data = JSON.parse(text);

                    if (!Array.isArray(data)) {
                        data = [data];
                    }

                    for (const obj of data) {
                        // 展开一个期刊对象为多行
                        const rows = expandObjectToRows(obj, { __filename: file.name });
                        rows.forEach(r => {
                            allRows.push(r);
                            Object.keys(r).forEach(k => allKeys.add(k));
                        });
                    }

                    // console.log(`Read file: ${file.name}, generated rows: ${allRows.length}`);
                } catch (err) {
                    console.error(`Failed to parse file: ${file.name}`, err.message);
                }
            }

            if (allRows.length === 0) {
                alert('No valid data found after parsing all JSON files');
                return;
            }

            const headers = Array.from(allKeys);

            const escapeCsv = (value) => {
                if (value === null || value === undefined) return '';
                let s = String(value);
                if (/[",\n\r]/.test(s)) {
                    s = '"' + s.replace(/"/g, '""') + '"';
                }
                return s;
            };

            const lines = [];
            lines.push(headers.map(escapeCsv).join(','));
            for (const row of allRows) {
                const line = headers.map(h => escapeCsv(row[h]));
                lines.push(line.join(','));
            }

            const csvContent = lines.join('\r\n');
            const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'merged.json.expanded.csv';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            alert(`完成！共 ${allRows.length} 行数据，已生成 merged.json.expanded.csv`);
        };

        input.click();
    }
}
const wosJcr = WosJcr.getInstance();



















































class WosQuery {
    static instance = null;

    static getInstance() {
        return WosQuery.instance || new WosQuery();
    }

    constructor() {
        if (WosQuery.instance) return WosQuery.instance;
        WosQuery.instance = this;
    }

    /** 从历史查询记录中查找指定表达式对应的查询结果
     */
    #findQueryInHistory(text) {
        let result = null;
        const entries = document.querySelectorAll('app-history-search-entry');
        for (const entry of entries) {
            const spanText = entry.querySelector('.query-details .query span span')?.textContent?.toLowerCase().trim() || '';

            if (spanText === text.toLowerCase().trim()) {
                const uuid = entry.getAttribute('data-hist-qid');

                let ref_count_text = entry.querySelector('a[data-ta="SearchHistory-records-count"]')?.textContent?.trim() || '';
                let ref_count = ref_count_text ? parseInt(ref_count_text.replace(/,/g, '')) : 0;

                result = {
                    uuid: uuid,
                    ref_count: ref_count
                };
                break;
            }
        }
        return result;
    }

    /** 在输入框中设置值并触发输入事件,以模拟用户输入
     */
    #setNativeInputValue(el, value) {
        const last = el.value;
        el.value = value;
        const event = new Event("input", { bubbles: true });
        const tracker = el._valueTracker;
        if (tracker) tracker.setValue(last); // React 特有
        el.dispatchEvent(event);
    }

    /** 检查当前结果页是否已经对应指定查询表达式
     */
    async #isCurrentQueryValid(expr) {
        if (window.location.pathname.startsWith("/wos/woscc/summary")) {
            // 判断当前搜索表达式是否匹配
            const searchTextEl = document.querySelector('.search-text');
            if (searchTextEl) {
                const _expr = searchTextEl.textContent?.trim() || '';
                if (_expr.toLowerCase() === expr.toLowerCase().trim()) {
                    return true;
                } else {
                    return false;
                }
            }
        }
        await wosGoto.openDefaultResultsPage();
        return false;
    }

    /** 在高级搜索页构建并提交查询，返回对应的结果信息
     */
    async buildQuery(expr = 'PY=(2025)') {
        // 进入高级搜索页面
        await wosGoto.goToAdvancedSearchPage();

        // 从历史查询中记录中获取
        const result = this.#findQueryInHistory(expr);
        if (result) {
            // 如果找到历史记录，直接使用
            const uuid = result.uuid;
            const ref_count = result.ref_count;
            return {
                uuid: uuid,
                rowText: expr,
                ref_count: ref_count,
                status: 'success'
            };
        }

        // 设置搜索框内容
        const input = document.querySelector('#advancedSearchInputArea');
        if (input) {
            input.value = expr;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        input?.dispatchEvent(new Event('input', { bubbles: true })); // 页面上的input监听器会响应

        const old_num = document.querySelectorAll('app-history-entries-list app-history-search-entry').length;

        // 尝试找到 "add to history" 按钮
        const findButtonLabelByText = (selector, keyText) => {
            return Array.from(document.querySelectorAll(selector)).find((el) =>
                (el.textContent || '').trim().toLowerCase().includes(keyText)
            ) || null;
        };

        let add_his = findButtonLabelByText('.mdc-button__label', 'add to history');
        if (!add_his) {
            // 如果没有 "add to history"，执行 search
            const temp = findButtonLabelByText('.button-row.adv.ng-star-inserted .mdc-button__label', 'search');
            if (temp) {
                temp.parentElement?.querySelector('mat-icon')?.click();
                await webWait.waitForElementBySelector(".mat-mdc-menu-item-text span", 100);
                document.querySelector('.mat-mdc-menu-item-text span')?.click();
                // 再次尝试获取 "add to history"

                await webFuncs.sleep(500); // 等待2秒，确保结果加载完成
                add_his = findButtonLabelByText('.mdc-button__label', 'add to history');
            }
        }
        add_his?.parentElement?.click();

        // 2秒内, 检查是否有错误信息出现
        const search_error = await webWait.waitForElementBySelector('.search-error.error-code.light-red-bg.ng-star-inserted', 20);
        if (search_error) {
            return {
                uuid: webFuncs.randomUuid(),
                ref_count: 0,
                rowText: expr,
                status: 'failed',
                error_code: document.querySelector('.search-error.error-code.light-red-bg.ng-star-inserted')?.textContent?.trim() || 'unknown error',
            };
        }

        // 5秒内循环判断,这里是判断历史记录列表长度是否变化
        const changeDetected = await webWait.waitForElementCountToChange("app-history-entries-list app-history-search-entry", old_num, 50);
        if (!changeDetected) {
            // console.error('查询未成功，可能是网络问题或页面结构变化');
            return {
                uuid: webFuncs.randomUuid(),
                ref_count: 0,
                rowText: expr,
                status: 'failed',
                error_code: 'unknown error',
            };
        }

        // 等待查询结果加载完成#
        const resEl = document.querySelector('app-history-search-entry');
        let uuid = resEl?.getAttribute('data-hist-qid');
        let ref_count = resEl?.querySelector('a[data-ta="SearchHistory-records-count"]')?.textContent || '';
        if (!ref_count) {
            ref_count = 0
        } else {
            ref_count = parseInt(ref_count.replace(/,/g, ''));
        }
        return {
            uuid: uuid,
            ref_count,
            rowText: expr,
            status: 'success',
        }
    }

    /** 在旧版结果页上下文中执行查询
     */
    async runLegacyQueryPage(expr = 'PY=(2025)') {
        // 进入 uuid 引用页面进行搜索
        if (await this.#isCurrentQueryValid(expr)) {
            const currentPageInfo = await wosUuidStore.fetchCurrentPageInfo(expr);
            if (currentPageInfo?.status === 'success') {
                return {
                    uuid: currentPageInfo.uuid,
                    ref_count: Number.parseInt(currentPageInfo.ref_count || '0', 10) || 0,
                    rowText: expr,
                    status: 'success',
                };
            }
            return {
                uuid: webFuncs.randomUuid(),
                ref_count: 0,
                rowText: expr,
                status: 'failed',
                error_code: 'failed to read current query page info',
            };
        }

        // 点击搜索框展开高级搜索输入区域
        const advInput = document.querySelector('#advancedSearchInputArea');
        const isVisible = !!(advInput && advInput.offsetParent !== null);
        if (!advInput || !isVisible) {
            document.querySelector('div[data-ta="search-terms"]')?.click();
            await webWait.waitForElementBySelector("#advancedSearchInputArea", 50, 100);
        }
        // 特殊方法在输入框中输入内容
        const advInputAfterOpen = document.querySelector('#advancedSearchInputArea');
        if (advInputAfterOpen) {
            this.#setNativeInputValue(advInputAfterOpen, expr);
        }
        await webFuncs.sleep(300);
        // 执行搜索
        document.querySelector('button[data-ta="run-search"]')?.click();
        await webFuncs.sleep(200);

        // 6秒内检查错误提示节点是否出现
        for (let i = 0; i < 30; i++) {
            if (document.querySelectorAll('.search-error.error-code').length > 0) {
                return {
                    uuid: webFuncs.randomUuid(),
                    ref_count: 0,
                    rowText: (document.querySelector('#advancedSearchInputArea')?.value || '').trim(),
                    status: 'failed',
                    error_code: document.querySelector('.search-error.error-code')?.textContent?.trim() || 'unknown error',
                };
            }
            await webFuncs.sleep(200);
        }

        const currentPageInfo = await wosUuidStore.fetchCurrentPageInfo(expr);
        if (currentPageInfo?.status === 'success') {
            return {
                uuid: currentPageInfo.uuid,
                ref_count: Number.parseInt(currentPageInfo.ref_count || '0', 10) || 0,
                rowText: expr,
                status: 'success',
            };
        }

        return {
            uuid: webFuncs.randomUuid(),
            ref_count: 0,
            rowText: expr,
            status: 'failed',
            error_code: 'failed to read query result page info',
        };
    }

    /** 通过通用结果页路由打开指定查询表达式
     */
    async openQueryPage(rowText = 'PY=2025') {
        const query = [{
            rowText: rowText,
        }];
        const jsonStr = encodeURIComponent(JSON.stringify(query))
        const queryUrl = `/wos/woscc/general-summary?queryJson=${jsonStr}`;
        const prevHref = window.location.href;
        window.history.pushState({}, "", queryUrl);
        window.dispatchEvent(new Event("popstate"));

        await webWait.waitForUrlChange(50, 100, prevHref);
    }

    /** 按 WOS ID 列表构造并打开查询页面
     */
    async queryWosIds(wosids = []) {
        await this.openQueryPage("UT=(" + wosids.join(" OR ") + ")");
    }

    /** 按 DOI 列表构造并打开查询页面
     */
    async queryDois(dois = []) {
        await this.openQueryPage("DO=(" + dois.join(" OR ") + ")");
    }

    /** 按 WOS ID 和 DOI 列表构造混合查询并打开结果页
     */
    async openQueryByWosIdsOrDois(wosIds = [], dois = []) {

        // 去重（使用 Set 确保完全去重）
        wosIds = [...new Set(wosIds)];
        dois = [...new Set(dois)];


        // 构建查询表达式
        let queryParts = [];

        if (wosIds.length > 0) {
            queryParts.push(`UT=(${wosIds.join(" OR ")})`);
        }

        if (dois.length > 0) {
            queryParts.push(`DO=(${dois.join(" OR ")})`);
        }

        // 如果有查询条件，通过 OR 拼接后执行
        if (queryParts.length > 0) {
            const queryText = queryParts.join(" OR ");
            await this.openQueryPage(queryText);
        }

        return { wosIds, dois };
    }

    /** 使用 WOS 内部搜索引擎解析自然语句并执行查询
     */
    async parseQueryWithSearchEngine(text) {
        try {
            const response = await fetch(`${window.location.origin}/api/esti/SearchEngine/parse`, {
                method: 'POST',
                headers: {
                    'accept': 'application/json',
                    'content-type': 'text/plain;charset=UTF-8',
                    ...(wosInfo.sid ? { 'x-1p-wos-sid': wosInfo.sid } : {}),
                },
                credentials: 'same-origin',
                body: JSON.stringify({
                    "userQuery": text,
                    "databaseID": "WOSCC",
                    "llmParse": false
                })
            });

            // 检查响应是否成功
            if (!response.ok) {
                console.error(`API request failed with status: ${response.status}`);
                return null;
            }

            // 尝试解析 JSON
            const data = await response.json();
            const rowText = data[0]?.query[0]?.rowText;
            if (rowText) {
                await this.openQueryPage(rowText);
            }
            return rowText;

        } catch (error) {
            console.error('Error calling WOS SearchEngine parse API:', error);
            return null;
        }
    }
}
const wosQuery = WosQuery.getInstance();


























































// Bind selected instance methods onto a plain object so callers keep the
// original receiver without touching the underlying store classes directly.
function bindApi(target, methodNames) {
    return Object.fromEntries(
        methodNames.map(name => [name, target[name].bind(target)])
    );
}

// Expose live internal state on the public API as getters instead of copying
// point-in-time values during construction.
function defineGetter(target, key, getter) {
    Object.defineProperty(target, key, {
        enumerable: true,
        get: getter,
    });
}

// 统一api 
class WOS {
    static instance = null;
    constructor() {
        if (WOS.instance) return WOS.instance;
        WOS.instance = this;

        this.session = {};
        defineGetter(this.session, 'sid', () => wosInfo.sid);

        this.nav = bindApi(wosGoto, [
            'goToWosPage',
        ]);

        this.query = bindApi(wosQuery, [
            'openQueryPage',
            'parseQueryWithSearchEngine',
            'buildQuery',
            'queryWosIds',
            'queryDois',
            'openQueryByWosIdsOrDois',
        ]);

        this.record = bindApi(wosIdStore, [
            'viewFullRecordByWosId',
            'collectCitationsByWosId',
            'collectReferencesByWosId',
            'collectRelatedRecordsByWosId',
            'collectSharedReferencesBetweenWosIds',
            'fetchFullRecordJsonByWosId',
            'parseCurrentFullRecordPage',
            'parseWosFullRecordAfterExpand',
            'expandWosFullRecord',
            'parseWosFullRecord',

        ]);
        defineGetter(this.record, 'currentWosId', () => wosIdStore.currentWosId);
        defineGetter(this.record, 'db', () => wosIdStore.db);

        this.results = bindApi(wosUuidStore, [
            'fetchCurrentPageInfo',
            'info',
            'update',
            'open',
            'viewResultsPageByUuid',
            'viewAnalyzeResultsByUuid',
            'viewCitationReportByUuid',
            'analyze_results',
            'citation_report',
            'collectRefineDataByUuid',
            'current_page_refine',
            'collectWosIdsByUuidPages',
            'collectWosIdsFromCurrentUuidPage',
            'current_page_all_wosids',
            'current_page_wosids',
            'goToPage',
            'goToNextPage',
            'goToPreviousPage',
            'valid',
            'extract',
            'save',
        ]);
        defineGetter(this.results, 'currentUuid', () => wosUuidStore.currentUuid);
        defineGetter(this.results, 'value', () => wosUuidStore.value);
        defineGetter(this.results, 'refine_typ', () => wosUuidStore.refine_typ);
        defineGetter(this.results, 'db', () => wosUuidStore.db);

        this.export = bindApi(wosUuidStore, [
            'saveTxtByUuidInBatches',
            'fetchTxtsByUuidInBatches',
            'fetchTxtBatches',
            'saveBibByUuidInBatches',
            'fetchBibsByUuidInBatches',
            'fetchBibBatches',
            'export_batchSize_toTxt',
            'export_batchSize_toBib',
            'export_batchSize',
            'export_pre_num',
            'export_pre_200',
        ]);

        this.guard = bindApi(webFuncs, [
            'startWosPopupGuard',
            'stopWosPopupGuard',
        ]);
    }
}
const wos = new WOS();
const version = '0.0.26.03.14.2';
window.wos = wos;
window.WosUUID = WosUuidStore;
window.asy_uuid = wosUuidStore;
window.asy_webFuncs = asy_webFuncs;
window.asy_webWait = asy_webWait;

if (!window.__WOS_ONETRUST_GUARD__) {
    window.__WOS_ONETRUST_GUARD__ = true;
    wos.guard.startWosPopupGuard({
        intervalMs: 2500,
        observeMs: 10000,
        observeAttributes: false,
    });
}

// Only log once on initial load (to minimize console history usage)
if (!window.__WOS_LOADED__) {
    console.log(`WOS API v${version} ready`);
    window.__WOS_LOADED__ = true;
}
