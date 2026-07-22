import java.util.Base64

plugins {
    id("com.android.application")
    id("kotlin-android")
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.tooyei.translator"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        applicationId = "com.tooyei.translator"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName

        // Flutter forwards --dart-define values to Gradle as a comma-separated
        // Base64 list. Decode APP_LINK_HOST so the native verified-link host and
        // the Dart router cannot silently diverge in a release build. A direct
        // -PAPP_LINK_HOST value remains available for native-only builds.
        val dartDefines = (project.findProperty("dart-defines") as String?)
            ?.split(',')
            ?.mapNotNull { encoded ->
                runCatching {
                    String(Base64.getDecoder().decode(encoded), Charsets.UTF_8)
                }.getOrNull()
            }
            ?.mapNotNull { value ->
                val separator = value.indexOf('=')
                if (separator <= 0) null
                else value.substring(0, separator) to value.substring(separator + 1)
            }
            ?.toMap()
            .orEmpty()
        val appLinkHost = (project.findProperty("APP_LINK_HOST") as String?)
            ?: dartDefines["APP_LINK_HOST"]
            ?: "www.ruscny.net"
        require(appLinkHost.matches(Regex("[A-Za-z0-9.-]{1,253}"))) {
            "APP_LINK_HOST must be a hostname without a scheme or path"
        }
        manifestPlaceholders["appLinkHost"] =
            appLinkHost
    }

    buildTypes {
        release {
            // CI supplies the release signing configuration. An unsigned local release is intentional.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
}

flutter {
    source = "../.."
}

dependencies {
    // ApsaraVideo Real-time Communication (ARTC) native audio engine. Its
    // matching Live+ ARTC credentials stay server-side and are never compiled
    // into the APK.
    implementation("com.aliyun.aio:AliVCSDK_ARTC:7.11.0")
}
