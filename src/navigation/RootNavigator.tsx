import React from 'react';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { View, ActivityIndicator } from 'react-native';
import { Home, Bell, CalendarDays, Settings as SettingsIcon } from 'lucide-react-native';
import { colors } from '../theme/tokens';
import { useAuth } from '../hooks/useAuth';
import { FloatingDock } from '../components/uv/FloatingDock';
import { LoginScreen } from '../screens/LoginScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { NotificationsScreen } from '../screens/NotificationsScreen';
import { WorkoutScreen } from '../screens/WorkoutScreen';
import { WorkoutDetailScreen } from '../screens/WorkoutDetailScreen';
import { SettingsScreen } from '../screens/SettingsScreen';

export type MainTabsParamList = { Home: undefined; Notifications: undefined; Workout: undefined; Settings: undefined };
export type RootStackParamList = {
  Main: { screen?: keyof MainTabsParamList } | undefined;
  WorkoutDetail: { sessionId: string };
};

const Tab = createBottomTabNavigator<MainTabsParamList>();
const Stack = createStackNavigator<RootStackParamList>();

function MainTabs() {
  return (
    <Tab.Navigator tabBar={(p) => <FloatingDock {...p} />} screenOptions={{ headerShown: false }}>
      <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarIcon: ({ color, size }) => <Home color={color} size={size} /> }} />
      <Tab.Screen name="Notifications" component={NotificationsScreen} options={{ tabBarLabel: 'Alerts', tabBarIcon: ({ color, size }) => <Bell color={color} size={size} /> }} />
      <Tab.Screen name="Workout" component={WorkoutScreen} options={{ tabBarIcon: ({ color, size }) => <CalendarDays color={color} size={size} /> }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarIcon: ({ color, size }) => <SettingsIcon color={color} size={size} /> }} />
    </Tab.Navigator>
  );
}

const theme = { ...DefaultTheme, dark: true, colors: { ...DefaultTheme.colors, background: colors.background, card: colors.card, text: colors.foreground, border: colors.border, primary: colors.primary } };

export function RootNavigator() {
  const { member, loading } = useAuth();
  if (loading) return <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.primary} /></View>;
  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator screenOptions={{ headerShown: false, cardStyle: { backgroundColor: colors.background } }}>
        {member ? (
          <>
            <Stack.Screen name="Main" component={MainTabs} />
            <Stack.Screen name="WorkoutDetail" component={WorkoutDetailScreen} />
          </>
        ) : (
          <Stack.Screen name="Main" component={LoginScreen} />
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
