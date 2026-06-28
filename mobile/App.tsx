import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { RunnerScreen } from "./src/screens/RunnerScreen";

export default function App() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#07080a" }}>
        <StatusBar style="light" />
        <RunnerScreen />
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
