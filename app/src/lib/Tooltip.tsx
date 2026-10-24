import type { ViewStyle } from 'react-native';

/**
 * Native (iOS/Android) sibling of `Tooltip.web.tsx`.
 *
 * Hover doesn't exist on touch, so this is a passthrough — it renders its
 * children unchanged and ignores `text`/`style`. The hover affordance is a
 * web-only nicety; on native, the same information is exposed to assistive tech
 * via the wrapped badge's `accessibilityLabel`. Keeping the web tooltip's
 * `react-dom` portal out of the native bundle is the whole point of the split.
 */
export function Tooltip({
  children,
}: {
  text: string;
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return <>{children}</>;
}
