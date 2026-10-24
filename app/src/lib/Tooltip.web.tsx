import { useCallback, useRef, useState } from 'react';
import { Pressable, Text, View, type ViewStyle } from 'react-native';
import { createPortal } from 'react-dom';

/**
 * A small, self-contained hover tooltip for the web build.
 *
 * Why this exists (and why it's a `.web` file): the obvious approach — a native
 * `title` attribute — does NOT work through react-native-web. RNW's
 * `forwardedProps` allowlist drops `title` from `<View>` (it forwards `dataSet`
 * and `aria-*`, but not `title`), so `<View title=...>` is silently a no-op and
 * the badge gets no visible hover. So we render a real tooltip ourselves.
 *
 * It must also survive a SCROLLING list: the pipeline sidebar is a vertical
 * `ScrollView`, which RNW renders with `overflow: auto` — that clips any
 * absolutely-positioned bubble (and any CSS `::after`) drawn inside a row. To
 * escape the clip we portal the bubble to `document.body` and position it
 * `fixed`, anchored to the trigger we measured on hover-in. (This matches the
 * `position:'fixed'` overlay convention already used in GraphEditor.web.tsx.)
 *
 * Hover state uses `Pressable`'s `onHoverIn`/`onHoverOut`, which RNW supports —
 * the same hover hooks already used elsewhere in the app (CommandPalette).
 *
 * The native (non-web) sibling, `Tooltip.tsx`, is a passthrough — touch UIs get
 * no hover, and screen-reader users are already served by the badge's
 * `accessibilityLabel`.
 */
export function Tooltip({
  text,
  children,
  style,
}: {
  text: string;
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  const ref = useRef<View>(null);
  // null = hidden. When shown, holds the trigger's viewport rect so the bubble
  // can anchor itself just below + left-aligned to the badge.
  const [rect, setRect] = useState<{
    left: number;
    top: number;
    height: number;
  } | null>(null);

  const show = useCallback(() => {
    const node = ref.current;
    if (!node || typeof node.measureInWindow !== 'function') return;
    // measureInWindow → viewport-relative coords (RNW maps it to
    // getBoundingClientRect), which line up with `position: fixed`.
    node.measureInWindow((x, y, _w, h) => setRect({ left: x, top: y, height: h }));
  }, []);
  const hide = useCallback(() => setRect(null), []);

  const doc: Document | undefined =
    typeof document !== 'undefined' ? document : undefined;

  return (
    <Pressable
      ref={ref}
      onHoverIn={show}
      onHoverOut={hide}
      // A tooltip trigger is informational, not a control — don't expose it as a
      // button to assistive tech; the badge inside still carries the a11y label.
      accessible={false}
      style={style}>
      {children}
      {rect && doc
        ? createPortal(
            <div
              // Let pointer events pass through so the bubble never eats hover /
              // clicks meant for what's underneath it.
              style={{
                position: 'fixed',
                left: rect.left,
                top: rect.top + rect.height + 6,
                maxWidth: 280,
                zIndex: 10000,
                pointerEvents: 'none',
                background: '#111827',
                color: '#f9fafb',
                fontSize: 11,
                lineHeight: '15px',
                padding: '6px 9px',
                borderRadius: 6,
                boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
                whiteSpace: 'normal',
                wordBreak: 'break-word',
              }}>
              <Text style={{ color: '#f9fafb', fontSize: 11, lineHeight: 15 }}>
                {text}
              </Text>
            </div>,
            doc.body,
          )
        : null}
    </Pressable>
  );
}
