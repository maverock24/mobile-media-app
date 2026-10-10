# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# Capacitor instantiates plugins reflectively via getDeclaredConstructor().newInstance().
# The shipped rule "-keep public class * extends com.getcapacitor.Plugin { *; }" keeps fields
# and methods but not <init>, so keep the no-arg constructors explicitly.
-keepclassmembers public class com.maverock24.mobilemediaapp.DirectoryReaderPlugin { public <init>(); }
-keepclassmembers public class com.maverock24.mobilemediaapp.GoogleDriveNativePlugin { public <init>(); }
-keepclassmembers public class com.maverock24.mobilemediaapp.MediaControlsPlugin { public <init>(); }
-keepclassmembers public class com.maverock24.mobilemediaapp.ScreenDimPlugin { public <init>(); }
-keepclassmembers public class com.maverock24.mobilemediaapp.YoutubeAudioPlugin { public <init>(); }
