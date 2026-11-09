import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { View, ActivityIndicator } from 'react-native';
import { useFonts, SpaceGrotesk_400Regular, SpaceGrotesk_500Medium, SpaceGrotesk_600SemiBold, SpaceGrotesk_700Bold } from '@expo-google-fonts/space-grotesk';
import { JetBrainsMono_500Medium, JetBrainsMono_700Bold } from '@expo-google-fonts/jetbrains-mono';
import { AuthProvider } from './src/hooks/useAuth';
import { RootNavigator } from './src/navigation/RootNavigator';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { startNetworkMonitor, stopNetworkMonitor } from './src/services/networkStatus';
import { startSyncQueue, stopSyncQueue } from './src/services/syncQueue';
import { getDb } from './src/db/database';
import { colors } from './src/theme/tokens';

export default function App() {
  const [fontsLoaded] = useFonts({
    SpaceGrotesk_400Regular,
    SpaceGrotesk_500Medium,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
    JetBrainsMono_500Medium,
    JetBrainsMono_700Bold,
  });

  useEffect(() => {
    // Open (and migrate) the local database as early as possible — every
    // other service assumes it's ready. Network monitor + sync queue run
    // for the app's whole lifetime, independent of whether a session is
    // active (see syncQueue.ts for why: it also drains member/session
    // lifecycle events, not just live-session ticks).
    getDb().catch((e) => console.error('[App] Failed to open database', e));
    startNetworkMonitor();
    startSyncQueue();
    return () => {
      stopSyncQueue();
      stopNetworkMonitor();
    };
  }, []);

  if (!fontsLoaded) {
    // Every screen's fontFamily reference (theme/tokens.ts) resolves to
    // nothing until these are loaded — rendering early would silently
    // fall back to the system font for a flash, which on a real device
    // reads as a layout jump once the real font swaps in. Block instead.
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <ErrorBoundary>
          <AuthProvider>
            <RootNavigator />
          </AuthProvider>
        </ErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
