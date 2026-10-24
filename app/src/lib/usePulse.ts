// Small Animated helpers for the live "this is running right now" affordances
// in the RN-based views (Pipeline + Tree) and the sidebar. The Graph view is
// raw DOM and uses an injected @keyframes instead (see GraphEditor.web.tsx).
//
// Note: react-native-web doesn't support the native driver, so every animation
// here passes useNativeDriver: false. opacity + transform animate fine on web
// via JS-driven values.

import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';

/** Looping opacity pulse (1 ↔ 0.35) for a running-node glow. When `active`
 *  flips false the loop stops and the value pins to 1. Apply the returned
 *  value to an `Animated.View`'s `opacity` style. */
export function usePulse(active: boolean): Animated.Value {
  const value = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) {
      value.stopAnimation();
      value.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: 0.35,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
        Animated.timing(value, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, value]);
  return value;
}

/** Continuous 0→360° rotation for a spinner glyph (e.g. the sidebar "⟳
 *  running" badge). Returns an interpolation to drop into a transform:
 *  `style={{ transform: [{ rotate }] }}` on an `Animated.Text`. */
export function useSpin(active: boolean): Animated.AnimatedInterpolation<string> {
  const value = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) {
      value.stopAnimation();
      value.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(value, {
        toValue: 1,
        duration: 1100,
        easing: Easing.linear,
        useNativeDriver: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, value]);
  return value.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });
}
