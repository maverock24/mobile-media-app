package com.maverock24.mobilemediaapp;

import android.content.Intent;

import androidx.benchmark.macro.CompilationMode;
import androidx.benchmark.macro.Metric;
import androidx.benchmark.macro.StartupMode;
import androidx.benchmark.macro.StartupTimingMetric;
import androidx.benchmark.macro.junit4.MacrobenchmarkRule;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.junit.Rule;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.Collections;
import java.util.List;

import kotlin.Unit;

/**
 * Startup macrobenchmarks for the app's single launcher activity, {@code MainActivity}
 * (the only {@code android.intent.category.LAUNCHER} activity in AndroidManifest.xml).
 *
 * <p>The target app is the minified, non-debuggable, debug-signed {@code benchmark}
 * variant of {@code :app}. Run on a connected device with
 * {@code ./gradlew :benchmark:connectedBenchmarkAndroidTest}.
 */
@RunWith(AndroidJUnit4.class)
public class StartupBenchmark {

    private static final String TARGET_PACKAGE = "com.maverock24.mobilemediaapp";
    private static final String LAUNCHER_ACTIVITY = TARGET_PACKAGE + ".MainActivity";
    private static final int ITERATIONS = 5;

    @Rule
    public MacrobenchmarkRule benchmarkRule = new MacrobenchmarkRule();

    @Test
    public void startupCold() {
        measureStartup(StartupMode.COLD);
    }

    @Test
    public void startupWarm() {
        measureStartup(StartupMode.WARM);
    }

    @Test
    public void startupHot() {
        measureStartup(StartupMode.HOT);
    }

    private void measureStartup(StartupMode startupMode) {
        List<Metric> metrics = Collections.singletonList(new StartupTimingMetric());
        benchmarkRule.measureRepeated(
                TARGET_PACKAGE,
                metrics,
                CompilationMode.DEFAULT,
                startupMode,
                ITERATIONS,
                scope -> {
                    scope.pressHome();
                    return Unit.INSTANCE;
                },
                scope -> {
                    Intent intent = new Intent(Intent.ACTION_MAIN);
                    intent.addCategory(Intent.CATEGORY_LAUNCHER);
                    intent.setClassName(TARGET_PACKAGE, LAUNCHER_ACTIVITY);
                    scope.startActivityAndWait(intent);
                    return Unit.INSTANCE;
                });
    }
}
