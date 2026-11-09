import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { AlertTriangle, RefreshCw } from 'lucide-react-native';
import { colors, fonts, radius, spacing } from '../theme/tokens';

interface Props {
  children: React.ReactNode;
  /** Shown in the fallback title, e.g. "Sensors hit an unexpected error" instead of the generic "Something went wrong". Used when this boundary wraps a single screen rather than the whole app. */
  label?: string;
  /**
   * Called (in addition to the internal error being cleared) when the
   * user taps "Try Again". A per-screen boundary passes a data-reload
   * function here so retrying doesn't just re-render stale state that
   * immediately throws the same error again.
   */
  onRetry?: () => void;
}
interface State {
  error: Error | null;
}

/**
 * Catches uncaught render errors anywhere below it in the tree and shows
 * a real screen — not React Native's raw red-screen-of-death in dev, and
 * not a silent blank screen in production (which is what a release build
 * does by default with no boundary at all: the app just goes white).
 *
 * Deliberately does NOT auto-navigate anywhere on error. A crash mid-live-
 * session should never look like "redirected to Home" — that would hide
 * the fact that something broke while a session might still be recording
 * fine in the background (the session engine and its SQLite writes are
 * independent of this component tree). "Try Again" re-renders in place;
 * it does not reset session state.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Intentionally just console.error for now — wire this to a real
    // crash-reporting service (Sentry, etc.) before shipping to
    // production. A silent catch with nowhere for the report to go is
    // barely better than no boundary at all.
    console.error('[ErrorBoundary] Uncaught render error:', error, info.componentStack);
  }

  private reset = () => {
    this.props.onRetry?.();
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return <ErrorFallback error={this.state.error} onRetry={this.reset} label={this.props.label} />;
    }
    return this.props.children;
  }
}

function ErrorFallback({ error, onRetry, label }: { error: Error; onRetry: () => void; label?: string }) {
  return (
    <View style={styles.root}>
      <View style={styles.iconWrap}>
        <AlertTriangle size={32} color={colors.destructive} />
      </View>
      <Text style={styles.title}>{label ? `${label} hit an error` : 'Something went wrong'}</Text>
      <Text style={styles.note}>
        {label
          ? `The ${label} screen ran into an unexpected error. Tap Try Again to reload just this screen — the rest of the app, and any session currently running, is unaffected.`
          : "This screen hit an unexpected error. If a session is currently running, it's still recording locally — this doesn't stop that."}
      </Text>

      <TouchableOpacity style={styles.button} onPress={onRetry}>
        <RefreshCw size={16} color={colors.primaryForeground} />
        <Text style={styles.buttonText}>Try Again</Text>
      </TouchableOpacity>

      {__DEV__ && (
        <ScrollView style={styles.debugBox}>
          <Text style={styles.debugText}>{error.message}</Text>
          <Text style={styles.debugStack}>{error.stack}</Text>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  iconWrap: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.destructive + '22', alignItems: 'center', justifyContent: 'center', marginBottom: spacing.lg },
  title: { fontFamily: fonts.heading, fontSize: 20, color: colors.foreground, marginBottom: spacing.sm },
  note: { fontFamily: fonts.body, fontSize: 13, color: colors.mutedForeground, textAlign: 'center', marginBottom: spacing.xl, lineHeight: 19 },
  button: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.primary, borderRadius: radius.md, paddingHorizontal: spacing.xl, paddingVertical: spacing.md },
  buttonText: { fontFamily: fonts.bodySemiBold, fontSize: 15, color: colors.primaryForeground },
  debugBox: { maxHeight: 200, marginTop: spacing.xl, width: '100%', backgroundColor: colors.card, borderRadius: radius.md, padding: spacing.md },
  debugText: { fontFamily: fonts.bodyMedium, fontSize: 12, color: colors.destructive, marginBottom: spacing.xs },
  debugStack: { fontFamily: 'monospace', fontSize: 10, color: colors.mutedForeground },
});
