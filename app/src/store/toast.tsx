import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/** Global toast queue. Mount once near the App root (in App.tsx via
 *  ToastProvider), call `useToast().show(msg, kind?)` anywhere.
 *
 *  Toasts auto-dismiss after 3s and stack in the bottom-right with
 *  a fade-in (no animation lib — just a flat list). Click-to-dismiss
 *  for stickier cases. */
export type ToastKind = 'info' | 'success' | 'error';
export type ToastOptions = {
  /** Click handler for the toast body. When set, the toast becomes an
   *  action ("click to open …") and only dismisses after the action fires. */
  onPress?: () => void;
  /** Override the auto-dismiss window (ms). Defaults to 3000. Pass a larger
   *  value for actionable toasts the user should have time to click. */
  durationMs?: number;
};
type Toast = {
  id: number;
  message: string;
  kind: ToastKind;
  createdAt: number;
  onPress?: () => void;
};

type Ctx = {
  show: (message: string, kind?: ToastKind, opts?: ToastOptions) => void;
};

const ToastContext = createContext<Ctx | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const show = useCallback(
    (message: string, kind: ToastKind = 'info', opts?: ToastOptions) => {
      const id = nextId.current++;
      const toast: Toast = {
        id,
        message,
        kind,
        createdAt: Date.now(),
        onPress: opts?.onPress,
      };
      setToasts(prev => [...prev, toast]);
      // Auto-dismiss. Actionable toasts linger longer so the user can click.
      const ttl = opts?.durationMs ?? (opts?.onPress ? 8000 : 3000);
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, ttl);
    },
    [],
  );

  const value = useMemo<Ctx>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastStack
        toasts={toasts}
        onDismiss={id => setToasts(prev => prev.filter(t => t.id !== id))}
      />
    </ToastContext.Provider>
  );
}

export function useToast(): Ctx {
  const ctx = useContext(ToastContext);
  // Return a no-op fallback so call sites don't crash if accidentally
  // mounted outside a provider (e.g. in jest tests without a wrapper).
  if (!ctx) {
    return {
      show: () => {
        /* no-op — provider not mounted */
      },
    };
  }
  return ctx;
}

function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  // Re-render every 200ms so the "age" indication (if any) stays
  // fresh; cheap because toasts.length is usually 0-3.
  const [, tick] = useState(0);
  useEffect(() => {
    if (toasts.length === 0) return;
    const h = setInterval(() => tick(n => n + 1), 200);
    return () => clearInterval(h);
  }, [toasts.length]);

  if (toasts.length === 0) return null;
  return (
    <View pointerEvents="box-none" style={styles.wrap}>
      {toasts.map(t => (
        <Pressable
          key={t.id}
          onPress={() => {
            // Actionable toasts run their handler first, then dismiss; plain
            // ones just dismiss (the body doubles as the dismiss target).
            t.onPress?.();
            onDismiss(t.id);
          }}
          style={[
            styles.toast,
            styles[`toast_${t.kind}`],
            t.onPress && styles.toastAction,
          ]}>
          <Text style={styles.text}>{t.message}</Text>
          <Text style={styles.dismiss}>{t.onPress ? '→' : '×'}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    bottom: 20,
    right: 20,
    gap: 8,
    maxWidth: 360,
    zIndex: 999,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    minWidth: 220,
  },
  toast_info: { backgroundColor: '#eff6ff', borderColor: '#bfdbfe' },
  toast_success: { backgroundColor: '#ecfdf5', borderColor: '#a7f3d0' },
  toast_error: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  // Actionable toasts get a slightly heavier border to read as clickable.
  toastAction: { borderWidth: 1.5 },
  text: { flex: 1, fontSize: 12, color: '#111827' },
  dismiss: { color: '#6b7280', fontWeight: '700', fontSize: 14 },
});
