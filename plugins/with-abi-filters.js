/**
 * UV Active — Gradle config plugin  (v4 — definitive CMake fix)
 *
 * Fixes "ninja: build.ninja still dirty after 100 tries" on Windows.
 *
 * ROOT CAUSE:
 *   react-native-screens builds C++ via CMake. The .cxx build artifacts are
 *   written inside node_modules/react-native-screens/android/.cxx/...
 *   On Windows, the combined path exceeds 260 chars (MAX_PATH). Ninja can't
 *   write its lock file, sees build.ninja as permanently dirty, loops 100x.
 *
 * THE FIX:
 *   Inject `buildStagingDirectory "C:/cxx/rnscreens"` into the OUTER
 *   android { externalNativeBuild { cmake { ... } } } block of
 *   react-native-screens/android/build.gradle.
 *
 *   This block uses CmakeOptions DSL which DOES support buildStagingDirectory.
 *   The INNER defaultConfig { externalNativeBuild { cmake { arguments... } } }
 *   block uses ExternalNativeCmakeOptions DSL which does NOT — injecting there
 *   causes "Could not get unknown property 'buildStagingDirectory'" (v3 bug).
 *
 * STRUCTURE of react-native-screens/android/build.gradle:
 *
 *   android {
 *     defaultConfig {
 *       externalNativeBuild {
 *         cmake {
 *           arguments "-DANDROID_STL=c++_shared", ...   ← ExternalNativeCmakeOptions
 *         }                                               (NO buildStagingDirectory here)
 *       }
 *     }
 *     externalNativeBuild {          ← THIS is where we inject
 *       cmake {
 *         path "CMakeLists.txt"      ← CmakeOptions DSL
 *       }                             (buildStagingDirectory IS valid here)
 *     }
 *   }
 */

const { withAppBuildGradle, withGradleProperties, withDangerousMod } = require('@expo/config-plugins');
const path = require('path');
const fs   = require('fs');

// ── 1. app/build.gradle — abiFilters ────────────────────────────────────────
const withAbiFilters = (config) => {
  return withAppBuildGradle(config, (mod) => {
    let gradle = mod.modResults.contents;
    if (!gradle.includes('abiFilters')) {
      gradle = gradle.replace(
        /(\s+)(versionName\s+"[^"]*")/,
        '$1$2\n$1    ndk {\n$1        abiFilters "arm64-v8a", "x86_64"\n$1    }'
      );
    }
    mod.modResults.contents = gradle;
    return mod;
  });
};

// ── 2. gradle.properties — ABI filter entries ────────────────────────────────
const withGradleAbiFilters = (config) => {
  return withGradleProperties(config, (mod) => {
    const props = [
      { key: 'android.abiFilters',      value: 'arm64-v8a,x86_64' },
      { key: 'reactNativeArchitectures', value: 'arm64-v8a,x86_64' },
    ];
    for (const { key, value } of props) {
      const existing = mod.modResults.find(
        (item) => item.type === 'property' && item.key === key
      );
      if (!existing) mod.modResults.push({ type: 'property', key, value });
      else existing.value = value;
    }
    return mod;
  });
};

// ── 3. Patch react-native-screens/android/build.gradle ───────────────────────
// Injects buildStagingDirectory into the OUTER android { externalNativeBuild
// { cmake { path "CMakeLists.txt" } } } block — CmakeOptions DSL.
// NOT into defaultConfig { externalNativeBuild { cmake { arguments } } }
// which is ExternalNativeCmakeOptions (no buildStagingDirectory property).
const withRNScreensCMakeFix = (config) => {
  return withDangerousMod(config, [
    'android',
    async (mod) => {
      const buildGradle = path.join(
        mod.modRequest.projectRoot,
        'node_modules', 'react-native-screens', 'android', 'build.gradle'
      );

      if (!fs.existsSync(buildGradle)) {
        console.warn('[cmake-fix] react-native-screens build.gradle not found — skipping');
        return mod;
      }

      let content = fs.readFileSync(buildGradle, 'utf8');

      if (content.includes('C:/cxx/rnscreens')) {
        console.log('[cmake-fix] already patched');
        return mod;
      }

      // Match the OUTER externalNativeBuild { cmake { path "CMakeLists.txt" } }
      // This block sits directly inside android { }, NOT inside defaultConfig { }.
      // We identify it by the presence of `path "CMakeLists.txt"` (no `arguments`).
      //
      // Strategy: find `path "CMakeLists.txt"` and insert buildStagingDirectory
      // on the next line after it.
      const pathLineRe = /([ \t]*path\s+"CMakeLists\.txt")/;
      if (!pathLineRe.test(content)) {
        console.warn('[cmake-fix] Could not find `path "CMakeLists.txt"` — skipping');
        return mod;
      }

      const patched = content.replace(
        pathLineRe,
        '$1\n            buildStagingDirectory "C:/cxx/rnscreens"'
      );

      fs.writeFileSync(buildGradle, patched, 'utf8');
      console.log('[cmake-fix] ✓ buildStagingDirectory "C:/cxx/rnscreens" injected into outer cmake block');
      return mod;
    },
  ]);
};

module.exports = (config) => {
  config = withAbiFilters(config);
  config = withGradleAbiFilters(config);
  config = withRNScreensCMakeFix(config);
  return config;
};
