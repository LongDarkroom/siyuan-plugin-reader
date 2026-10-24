const createSVGElement = tag =>
    document.createElementNS('http://www.w3.org/2000/svg', tag)

let overlayerCounter = 0

// REword patch (2026-10-13): 确定性伪随机工具，供 Overlayer.marker 使用。
// FNV-1a 字符串哈希 + mulberry32 PRNG：同一 seed（标注 CFI）⊕ 行号
// 每次重绘产生完全相同的形状，翻页返回/字号调整后笔触不会"闪变"。
const hashString = s => {
    let h = 2166136261
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 16777619)
    }
    return h >>> 0
}

const mulberry32 = a => () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// REword patch (2026-10-14): 批注线性图标 —— 对话气泡线稿，默认画在末行右端外溢处，
// 用于区分「带笔记的批注」与「纯划线」。独立 <g>：stroke=标注饱和色、fill=none，
// 不参与 marker 的 multiply/opacity，保持线条清晰。右端超出内容区则改首行左端。
const noteIconGlyph = (rects, color, frameWidth) => {
    if (!rects || !rects.length) return null
    const last = rects[rects.length - 1]
    const first = rects[0]
    const h = last.bottom - last.top
    if (!(h > 0)) return null
    const s = Math.min(12, Math.max(9, h * 0.55))
    const gap = 3
    const cy = (last.top + last.bottom) / 2
    let x = last.right + gap
    if (frameWidth > 0 && x + s + 4 > frameWidth) x = Math.max(first.left - gap - s, 2)
    const g = createSVGElement('g')
    g.setAttribute('fill', 'none')
    g.setAttribute('stroke', color)
    g.setAttribute('stroke-width', '1.5')
    g.setAttribute('stroke-linecap', 'round')
    g.setAttribute('stroke-linejoin', 'round')
    const bodyH = s * 0.8
    const body = createSVGElement('rect')
    body.setAttribute('x', String(x))
    body.setAttribute('y', String(cy - bodyH / 2))
    body.setAttribute('width', String(s))
    body.setAttribute('height', String(bodyH))
    body.setAttribute('rx', String(s * 0.22))
    g.append(body)
    const tail = createSVGElement('path')
    tail.setAttribute('d',
        `M ${x + s * 0.25} ${cy + bodyH / 2 - 1}` +
        ` L ${x + s * 0.2} ${cy + bodyH / 2 + s * 0.3}` +
        ` L ${x + s * 0.55} ${cy + bodyH / 2 - 1}`)
    g.append(tail)
    return g
}

export class Overlayer {
    #svg = createSVGElement('svg')
    #map = new Map()
    #doc = null
    #clipPath = null
    #clipPathPath = null
    #clipPathId

    constructor(doc) {
        this.#doc = doc
        this.#clipPathId = `foliate-loupe-clip-${overlayerCounter++}`
        Object.assign(this.#svg.style, {
            position: 'absolute', top: '0', left: '0',
            width: '100%', height: '100%',
            pointerEvents: 'none',
        })

        // Create a clipPath to cut a hole for the loupe.
        // We use clip-rule="evenodd" with a large outer rect and inner circle
        // to create the hole effect efficiently without mask compositing.
        const defs = createSVGElement('defs')
        this.#clipPath = createSVGElement('clipPath')
        this.#clipPath.setAttribute('id', this.#clipPathId)
        this.#clipPath.setAttribute('clipPathUnits', 'userSpaceOnUse')

        this.#clipPathPath = createSVGElement('path')
        this.#clipPathPath.setAttribute('clip-rule', 'evenodd')
        this.#clipPathPath.setAttribute('fill-rule', 'evenodd') // for older renderers

        this.#clipPath.append(this.#clipPathPath)
        defs.append(this.#clipPath)
        this.#svg.append(defs)
    }

    setHole(cx, cy, w, h, r) {
        // Define a path with a large outer rect and a capsule-shaped hole.
        // The capsule is a rounded rectangle (stadium shape) centred at (cx, cy).
        const outer = 'M -2000000 -2000000 H 4000000 V 4000000 H -2000000 Z'
        const hw = w / 2, hh = h / 2
        const cr = Math.min(r, hw, hh) // clamp corner radius
        const inner = `M ${cx - hw + cr} ${cy - hh}`
            + ` H ${cx + hw - cr}`
            + ` A ${cr} ${cr} 0 0 1 ${cx + hw} ${cy - hh + cr}`
            + ` V ${cy + hh - cr}`
            + ` A ${cr} ${cr} 0 0 1 ${cx + hw - cr} ${cy + hh}`
            + ` H ${cx - hw + cr}`
            + ` A ${cr} ${cr} 0 0 1 ${cx - hw} ${cy + hh - cr}`
            + ` V ${cy - hh + cr}`
            + ` A ${cr} ${cr} 0 0 1 ${cx - hw + cr} ${cy - hh} Z`
        this.#clipPathPath.setAttribute('d', `${outer} ${inner}`)

        this.#svg.setAttribute('clip-path', `url(#${this.#clipPathId})`)
        this.#svg.style.webkitClipPath = `url(#${this.#clipPathId})`
    }

    clearHole() {
        this.#svg.removeAttribute('clip-path')
        this.#svg.style.webkitClipPath = ''
        this.#clipPathPath.removeAttribute('d')
    }

    get element() {
        return this.#svg
    }
    get #zoom() {
        // Safari does not zoom the client rects, while Chrome, Edge and Firefox does
        if (/^((?!chrome|android).)*AppleWebKit/i.test(navigator.userAgent) && !window.chrome) {
            return window.getComputedStyle(this.#doc.body).zoom || 1.0
        }
        return 1.0
    }
    // Split a range into per-text-node sub-ranges (plus replaced elements
    // like images), so `getClientRects()` only ever returns line-level boxes.
    // Collecting rects on the whole range would also include the border boxes
    // of fully contained block elements, over-highlighting blank space.
    #splitRange(range) {
        const ancestor = range.commonAncestorContainer
        if (ancestor.nodeType !== Node.ELEMENT_NODE
            && ancestor.nodeType !== Node.DOCUMENT_NODE) return [range]
        const doc = ancestor.ownerDocument ?? ancestor
        const walker = doc.createTreeWalker(ancestor,
            NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
                acceptNode: node => {
                    if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT
                    // Ruby annotations sit on their own line above (or beside)
                    // the base, so their rects would draw a second detached box
                    // over the furigana. Never paint them — not the book's own
                    // ruby, not injected glosses.
                    const el = node.nodeType === Node.TEXT_NODE
                        ? node.parentElement : node
                    if (el?.closest?.('rt, rp, rtc, [cfi-inert]'))
                        return NodeFilter.FILTER_REJECT
                    if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT
                    return node.matches?.('img, svg')
                        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
                },
            })
        const splitRanges = []
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const subRange = doc.createRange()
            if (node.nodeType === Node.TEXT_NODE) {
                subRange.selectNodeContents(node)
                if (subRange.compareBoundaryPoints(Range.START_TO_START, range) < 0) {
                    subRange.setStart(range.startContainer, range.startOffset)
                }
                if (subRange.compareBoundaryPoints(Range.END_TO_END, range) > 0) {
                    subRange.setEnd(range.endContainer, range.endOffset)
                }
            } else subRange.selectNode(node)
            splitRanges.push(subRange)
        }
        return splitRanges.length === 0 ? [range] : splitRanges
    }
    #getRects(range) {
        const zoom = this.#zoom
        const rects = []
        for (const subRange of this.#splitRange(range)) {
            for (const rect of subRange.getClientRects()) {
                rects.push({
                    left: rect.left * zoom,
                    top: rect.top * zoom,
                    right: rect.right * zoom,
                    bottom: rect.bottom * zoom,
                    width: rect.width * zoom,
                    height: rect.height * zoom,
                })
            }
        }
        return rects
    }
    add(key, range, draw, options) {
        if (this.#map.has(key)) this.remove(key)
        if (typeof range === 'function') range = range(this.#svg.getRootNode())
        const rects = this.#getRects(range)
        const element = draw(rects, options)
        this.#svg.append(element)
        this.#map.set(key, { range, draw, options, element, rects })
    }
    remove(key) {
        if (!this.#map.has(key)) return
        this.#svg.removeChild(this.#map.get(key).element)
        this.#map.delete(key)
    }
    // REword patch (2026-08-24): 按条件批量安全删除。
    // 遍历私有 #map 的 key，对满足 predicate 的逐条调用 remove()，
    // 内部有 #map.has 检查 + removeChild，保持 #map 与 SVG 完全一致，
    // 避免外部暴力 removeChild 造成 #map 悬空引用、redraw() 崩溃。
    removeBy(predicate) {
        let removed = 0
        for (const key of [...this.#map.keys()]) {
            if (predicate(key)) {
                this.remove(key)
                removed++
            }
        }
        return removed
    }
    // REword patch (2026-08-24): 只读探测是否存在满足 predicate 的标注。
    // 用于删除流程的「删前/删后」验证，不产生任何副作用。
    hasBy(predicate) {
        for (const key of this.#map.keys()) {
            if (predicate(key)) return true
        }
        return false
    }
    redraw() {
        for (const obj of this.#map.values()) {
            const { range, draw, options, element } = obj
            this.#svg.removeChild(element)
            const rects = this.#getRects(range)
            const el = draw(rects, options)
            this.#svg.append(el)
            obj.element = el
            obj.rects = rects
        }
    }
    hitTest({ x, y }) {
        const arr = Array.from(this.#map.entries())
        // loop in reverse to hit more recently added items first
        for (let i = arr.length - 1; i >= 0; i--) {
            const tolerance = 5
            const [key, obj] = arr[i]
            for (const { left, top, right, bottom } of obj.rects) {
                if (
                    top <= y + tolerance &&
                    left <= x + tolerance &&
                    bottom > y - tolerance &&
                    right > x - tolerance
                ) {
                    return [key, obj.range, { left, top, right, bottom }]
                }
            }
        }
        return []
    }
    static underline(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 2, padding = 0, writingMode } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', color)
        if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr')
            for (const { right, top, height } of rects) {
                const el = createSVGElement('rect')
                el.setAttribute('x', right - strokeWidth / 2 + padding)
                el.setAttribute('y', top)
                el.setAttribute('height', height)
                el.setAttribute('width', strokeWidth)
                g.append(el)
            }
        else for (const { left, bottom, width } of rects) {
            const el = createSVGElement('rect')
            el.setAttribute('x', left)
            el.setAttribute('y', bottom - strokeWidth / 2 + padding)
            el.setAttribute('height', strokeWidth)
            el.setAttribute('width', width)
            g.append(el)
        }
        return g
    }
    static strikethrough(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 2, writingMode } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', color)
        if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr')
            for (const { right, left, top, height } of rects) {
                const el = createSVGElement('rect')
                el.setAttribute('x', (right + left) / 2)
                el.setAttribute('y', top)
                el.setAttribute('height', height)
                el.setAttribute('width', strokeWidth)
                g.append(el)
            }
        else for (const { left, top, bottom, width } of rects) {
            const el = createSVGElement('rect')
            el.setAttribute('x', left)
            el.setAttribute('y', (top + bottom) / 2)
            el.setAttribute('height', strokeWidth)
            el.setAttribute('width', width)
            g.append(el)
        }
        return g
    }
    static squiggly(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 2, padding = 0, writingMode } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', 'none')
        g.setAttribute('stroke', color)
        g.setAttribute('stroke-width', strokeWidth)
        const block = strokeWidth * 1.5
        if (writingMode === 'vertical-rl' || writingMode === 'vertical-lr')
            for (const { right, top, height } of rects) {
                const el = createSVGElement('path')
                const n = Math.round(height / block / 1.5)
                const inline = height / n
                const ls = Array.from({ length: n },
                    (_, i) => `l${i % 2 ? -block : block} ${inline}`).join('')
                el.setAttribute('d', `M${right - strokeWidth / 2 + padding} ${top}${ls}`)
                g.append(el)
            }
        else for (const { left, bottom, width } of rects) {
            const el = createSVGElement('path')
            const n = Math.round(width / block / 1.5)
            const inline = width / n
            const ls = Array.from({ length: n },
                (_, i) => `l${inline} ${i % 2 ? block : -block}`).join('')
            el.setAttribute('d', `M${left} ${bottom + strokeWidth / 2 + padding}${ls}`)
            g.append(el)
        }
        return g
    }
    static dashed(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 2, padding = 0 } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', 'none')
        g.setAttribute('stroke', color)
        g.setAttribute('stroke-width', strokeWidth)
        g.setAttribute('stroke-dasharray', `${strokeWidth * 2.4} ${strokeWidth * 1.8}`)
        for (const { left, bottom, width } of rects) {
            const el = createSVGElement('line')
            el.setAttribute('x1', left)
            el.setAttribute('y1', bottom + strokeWidth / 2 + padding)
            el.setAttribute('x2', left + width)
            el.setAttribute('y2', bottom + strokeWidth / 2 + padding)
            g.append(el)
        }
        return g
    }
    static dotted(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 2, padding = 0 } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', 'none')
        g.setAttribute('stroke', color)
        g.setAttribute('stroke-width', strokeWidth)
        g.setAttribute('stroke-dasharray', `${strokeWidth * 0.6} ${strokeWidth * 1.8}`)
        g.setAttribute('stroke-linecap', 'round')
        for (const { left, bottom, width } of rects) {
            const el = createSVGElement('line')
            el.setAttribute('x1', left)
            el.setAttribute('y1', bottom + strokeWidth / 2 + padding)
            el.setAttribute('x2', left + width)
            el.setAttribute('y2', bottom + strokeWidth / 2 + padding)
            g.append(el)
        }
        return g
    }
    static highlight(rects, options = {}) {
        const {
            color = 'red',
            padding = 0,
            radius = 4,
            radiusPadding = 2,
            vertical = false,
        } = options

        const g = createSVGElement('g')
        g.setAttribute('fill', color)
        g.style.opacity = 'var(--overlayer-highlight-opacity, .3)'
        g.style.mixBlendMode = 'var(--overlayer-highlight-blend-mode, normal)'

        for (const [index, { left, top, height, width }] of rects.entries()) {
            const isFirst = index === 0
            const isLast = index === rects.length - 1

            let x, y, w, h

            let radiusTopLeft, radiusTopRight, radiusBottomRight, radiusBottomLeft

            if (vertical) {
                x = left - padding
                y = top - padding - (isFirst ? radiusPadding : 0)
                w = width + padding * 2
                h = height + padding * 2 + (isFirst ? radiusPadding : 0) + (isLast ? radiusPadding : 0)
                radiusTopLeft = isFirst ? radius : 0
                radiusTopRight = isFirst ? radius : 0
                radiusBottomRight = isLast ? radius : 0
                radiusBottomLeft = isLast ? radius : 0
            } else {
                x = left - padding - (isFirst ? radiusPadding : 0)
                y = top - padding
                w = width + padding * 2 + (isFirst ? radiusPadding : 0) + (isLast ? radiusPadding : 0)
                h = height + padding * 2
                radiusTopLeft = isFirst ? radius : 0
                radiusTopRight = isLast ? radius : 0
                radiusBottomRight = isLast ? radius : 0
                radiusBottomLeft = isFirst ? radius : 0
            }

            const rtl = Math.min(radiusTopLeft, w / 2, h / 2)
            const rtr = Math.min(radiusTopRight, w / 2, h / 2)
            const rbr = Math.min(radiusBottomRight, w / 2, h / 2)
            const rbl = Math.min(radiusBottomLeft, w / 2, h / 2)

            if (rtl === 0 && rtr === 0 && rbr === 0 && rbl === 0) {
                const el = createSVGElement('rect')
                el.setAttribute('x', x)
                el.setAttribute('y', y)
                el.setAttribute('height', h)
                el.setAttribute('width', w)
                g.append(el)
            } else {
                const el = createSVGElement('path')
                const d = `
                M ${x + rtl} ${y}
                L ${x + w - rtr} ${y}
                ${rtr > 0 ? `Q ${x + w} ${y} ${x + w} ${y + rtr}` : `L ${x + w} ${y}`}
                L ${x + w} ${y + h - rbr}
                ${rbr > 0 ? `Q ${x + w} ${y + h} ${x + w - rbr} ${y + h}` : `L ${x + w} ${y + h}`}
                L ${x + rbl} ${y + h}
                ${rbl > 0 ? `Q ${x} ${y + h} ${x} ${y + h - rbl}` : `L ${x} ${y + h}`}
                L ${x} ${y + rtl}
                ${rtl > 0 ? `Q ${x} ${y} ${x + rtl} ${y}` : `L ${x} ${y}`}
                Z
            `.trim().replace(/\s+/g, ' ')
                el.setAttribute('d', d)
                g.append(el)
            }
        }
        return g
    }
    // REword patch (2026-10-13): 微信读书同款「手绘马克笔」高亮。
    // 机制复刻自微信读书客户端：其划线为 start(左帽)/middle(中段拉伸)/end(右帽)
    // 三段式预渲染纹理逐行贴图（纹理尺寸 30x72 / 102x72 / 30x72 @2x，笔触高约 36pt、
    // 比行高略大），手绘感全部烘焙在纹理的不规则边缘里。此处以等效矢量路径实现：
    //   - 左右端帽 = 外鼓圆头 + 顶/底独立微倾斜（落笔/收笔不平）
    //   - 中段顶/底边 = 2 段贝塞尔，控制点确定性波动（模拟纹理边缘噪点）
    //   - 端部外溢 1~3.5px（笔头扫出字界）
    // 每行一条闭合 path，fill=用户色；multiply 混合（不透明度历次调整见下方 dated 注释）。
    // 2026-10-13 二次修正（已被 2026-10-14 取代）：微信读书笔触是不透明纹理画在文字下层，最终呈现=调色板
    // 原色（截图实测紫 #e7d8fc）。此前 0.4 透明度把颜色冲淡一层，观感偏灰浅；
    // 当时改为 opacity 0.9。
    // 2026-10-13 真机修正：笔触高从 1.3×行高降到 0.82×行高并加逐行垂直微移——
    // 1.3× 会把行间隙全部填满、连成整段色块（真机截图问题）；微信读书观感是
    // 笔触只盖住文字带、行与行之间留缝、颜色半透明。
    // 形状由 seed(标注 CFI)⊕行号 的确定性伪随机驱动，redraw 后不变。
    // 2026-10-14 复刻微信读书「饱和原色 → 淡彩呈现」两段式机制：色板存饱和原色
    // （与工具栏色点同值），marker 以 opacity 0.38 叠纸呈现淡彩——微信截图逐色反推
    // α 0.35~0.44（均值 0.38），0.38 合成淡彩与旧淡彩色板观感差 Δ≤6。multiply 保证
    // 文字全黑清晰。笔触形状（seed 驱动、0.95 行高、端帽外溢）不变。
    // 2026-10-14 批注图标：options.noteIcon=true 时在末行右端画对话气泡线稿（独立 g，
    // stroke=标注色，不参与 multiply/opacity），用于区分「带笔记批注」与「纯划线」；
    // frameWidth=内容区宽度，右端放不下则改首行左端。
    static marker(rects, options = {}) {
        const { color = 'red', seed = '', opacity = 0.38, noteIcon = false, frameWidth = 0 } = options
        const g = createSVGElement('g')
        const paths = createSVGElement('g')
        paths.setAttribute('fill', color)
        paths.style.opacity = String(opacity)
        paths.style.mixBlendMode = 'multiply'
        const base = hashString(String(seed))
        for (const [index, rect] of rects.entries()) {
            const rnd = mulberry32((base ^ Math.imul(index + 1, 0x9E3779B1)) >>> 0)
            const h = rect.bottom - rect.top
            const w = rect.right - rect.left
            if (h <= 0 || w <= 0) continue
            const cy = (rect.top + rect.bottom) / 2
            const drawH = h * 0.95                       // 文字上下各留 ~2.5% 行盒空间（微信观感）
            const yJit = (rnd() - 0.5) * h * 0.05        // 逐行垂直微移（划线不齐的手感）
            const top = cy - drawH / 2 + yJit
            const bot = cy + drawH / 2 + yJit
            const amp = Math.min(1.0, drawH * 0.05)      // 边缘波动幅度
            const xL = rect.left - 1 - rnd() * 2.5      // 起笔外溢
            const xR = rect.right + 1 + rnd() * 2.5     // 收笔外溢
            // 端帽四角独立微倾斜（落笔/收笔不平）
            const tL = (rnd() - 0.5) * 1.4
            const bL = (rnd() - 0.5) * 1.4
            const tR = (rnd() - 0.5) * 1.4
            const bR = (rnd() - 0.5) * 1.4
            // 顶/底边各 2 段贝塞尔，控制点 y 独立波动
            const mx1 = xL + (xR - xL) * 0.33
            const mx2 = xL + (xR - xL) * 0.66
            const t1 = top + (rnd() - 0.5) * 2 * amp
            const t2 = top + (rnd() - 0.5) * 2 * amp
            const b1 = bot + (rnd() - 0.5) * 2 * amp
            const b2 = bot + (rnd() - 0.5) * 2 * amp
            const bulgeL = 1 + rnd() * 1.5              // 端头外鼓（笔锋圆头）
            const bulgeR = 1 + rnd() * 1.5
            const el = createSVGElement('path')
            el.setAttribute('d',
                `M ${xL} ${top + tL}` +
                ` C ${mx1} ${t1}, ${mx2} ${t2}, ${xR} ${top + tR}` +
                ` Q ${xR + bulgeR} ${cy}, ${xR} ${bot + bR}` +
                ` C ${mx2} ${b2}, ${mx1} ${b1}, ${xL} ${bot + bL}` +
                ` Q ${xL - bulgeL} ${cy}, ${xL} ${top + tL} Z`)
            paths.append(el)
        }
        g.append(paths)
        if (noteIcon) {
            const icon = noteIconGlyph(rects, color, frameWidth)
            if (icon) g.append(icon)
        }
        return g
    }
    static outline(rects, options = {}) {
        const { color = 'red', width: strokeWidth = 3, padding = 0, radius = 3 } = options
        const g = createSVGElement('g')
        g.setAttribute('fill', 'none')
        g.setAttribute('stroke', color)
        g.setAttribute('stroke-width', strokeWidth)
        for (const { left, top, height, width } of rects) {
            const el = createSVGElement('rect')
            el.setAttribute('x', left - padding)
            el.setAttribute('y', top - padding)
            el.setAttribute('height', height + padding * 2)
            el.setAttribute('width', width + padding * 2)
            el.setAttribute('rx', radius)
            g.append(el)
        }
        return g
    }
    static bubble(rects, options = {}) {
        const { color = '#fbbf24', writingMode, opacity = 0.85, size = 20, padding = 10 } = options
        const isVertical = writingMode === 'vertical-rl' || writingMode === 'vertical-lr'
        const g = createSVGElement('g')
        g.style.opacity = opacity
        if (rects.length === 0) return g
        rects.splice(1)
        const firstRect = rects[0]
        const x = isVertical ? firstRect.right - size + padding : firstRect.right - size + padding
        const y = isVertical ? firstRect.bottom - size + padding : firstRect.top - size + padding
        firstRect.top = y - padding
        firstRect.right = x + size + padding
        firstRect.bottom = y + size + padding
        firstRect.left = x - padding
        const bubble = createSVGElement('path')
        const s = size
        const r = s * 0.15
        // Speech bubble shape with a small tail
        // Main rounded rectangle body
        const d = `
            M ${x + r} ${y}
            h ${s - 2 * r}
            a ${r} ${r} 0 0 1 ${r} ${r}
            v ${s * 0.65 - 2 * r}
            a ${r} ${r} 0 0 1 ${-r} ${r}
            h ${-s * 0.3}
            l ${-s * 0.15} ${s * 0.2}
            l ${s * 0.05} ${-s * 0.2}
            h ${-s * 0.6 + 2 * r}
            a ${r} ${r} 0 0 1 ${-r} ${-r}
            v ${-s * 0.65 + 2 * r}
            a ${r} ${r} 0 0 1 ${r} ${-r}
            z
        `.replace(/\s+/g, ' ').trim()

        bubble.setAttribute('d', d)
        bubble.setAttribute('fill', color)
        bubble.setAttribute('stroke', 'rgba(0, 0, 0, 0.2)')
        bubble.setAttribute('stroke-width', '1')
        // Add horizontal lines inside to represent text
        const lineGroup = createSVGElement('g')
        lineGroup.setAttribute('stroke', 'rgba(0, 0, 0, 0.3)')
        lineGroup.setAttribute('stroke-width', '1.5')
        lineGroup.setAttribute('stroke-linecap', 'round')
        const lineY1 = y + s * 0.18
        const lineY2 = y + s * 0.33
        const lineY3 = y + s * 0.48
        const lineX1 = x + s * 0.2
        const lineX2 = x + s * 0.8
        const line1 = createSVGElement('line')
        line1.setAttribute('x1', lineX1)
        line1.setAttribute('y1', lineY1)
        line1.setAttribute('x2', lineX2)
        line1.setAttribute('y2', lineY1)
        const line2 = createSVGElement('line')
        line2.setAttribute('x1', lineX1)
        line2.setAttribute('y1', lineY2)
        line2.setAttribute('x2', lineX2)
        line2.setAttribute('y2', lineY2)
        const line3 = createSVGElement('line')
        line3.setAttribute('x1', lineX1)
        line3.setAttribute('y1', lineY3)
        line3.setAttribute('x2', x + s * 0.6)
        line3.setAttribute('y2', lineY3)
        lineGroup.append(line1, line2, line3)

        if (isVertical) {
            const centerX = x + s / 2
            const centerY = y + s / 2
            bubble.setAttribute('transform', `rotate(90 ${centerX} ${centerY})`)
            lineGroup.setAttribute('transform', `rotate(90 ${centerX} ${centerY})`)
        }

        g.append(bubble)
        g.append(lineGroup)
        return g
    }
    // make an exact copy of an image in the overlay
    // one can then apply filters to the entire element, without affecting them;
    // it's a bit silly and probably better to just invert images twice
    // (though the color will be off in that case if you do heu-rotate)
    static copyImage([rect], options = {}) {
        const { src } = options
        const image = createSVGElement('image')
        const { left, top, height, width } = rect
        image.setAttribute('href', src)
        image.setAttribute('x', left)
        image.setAttribute('y', top)
        image.setAttribute('height', height)
        image.setAttribute('width', width)
        return image
    }
}

