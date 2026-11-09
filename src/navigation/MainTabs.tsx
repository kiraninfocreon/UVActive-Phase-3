import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Home, Users, Settings as SettingsIcon, Radio, Dumbbell } from 'lucide-react-native';
import { HomeScreen } from '../screens/HomeScreen';
import { SessionsScreen } from '../screens/SessionsScreen';
import { MembersScreen } from '../screens/MembersScreen';
import { SensorsScreen } from '../screens/SensorsScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { FloatingDock } from '../components/uv/FloatingDock';
import { withScreenBoundary } from '../components/withScreenBoundary';

// Each tab screen gets its own error boundary — see withScreenBoundary.tsx
// for why: a crash while, say, connecting a sensor should stay contained
// to the Sensors tab instead of taking down the whole app.
const BoundedHome = withScreenBoundary(HomeScreen, 'Home');
const BoundedSessions = withScreenBoundary(SessionsScreen, 'Sessions');
const BoundedMembers = withScreenBoundary(MembersScreen, 'Members');
const BoundedSensors = withScreenBoundary(SensorsScreen, 'Sensors');
const BoundedSettings = withScreenBoundary(SettingsScreen, 'Settings');

// History is deliberately NOT a tab anymore — completed/past sessions
// live under the Sessions tab's "Past" section (tap a row for details).
export type MainTabsParamList = {
  Home: undefined;
  Sessions: undefined;
  Members: undefined;
  Sensors: undefined;
  Settings: undefined;
};

const Tab = createBottomTabNavigator<MainTabsParamList>();

export function MainTabs() {
  return (
    <Tab.Navigator
      tabBar={(props) => <FloatingDock {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tab.Screen name="Home" component={BoundedHome} options={{ tabBarIcon: ({ color, size }) => <Home color={color} size={size} /> }} />
      <Tab.Screen name="Sessions" component={BoundedSessions} options={{ tabBarIcon: ({ color, size }) => <Dumbbell color={color} size={size} /> }} />
      <Tab.Screen name="Members" component={BoundedMembers} options={{ tabBarIcon: ({ color, size }) => <Users color={color} size={size} /> }} />
      <Tab.Screen name="Sensors" component={BoundedSensors} options={{ tabBarIcon: ({ color, size }) => <Radio color={color} size={size} /> }} />
      <Tab.Screen name="Settings" component={BoundedSettings} options={{ tabBarIcon: ({ color, size }) => <SettingsIcon color={color} size={size} /> }} />
    </Tab.Navigator>
  );
}
