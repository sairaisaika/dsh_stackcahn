# 开发时使用 Wiki 与 hook

首次执行 `python3 scripts/prepare_wiki_hook.py` 获取 `.project-wiki/skill.lock.json` 固定的脚本与许可证（上游 PR #73 的合并提交），不修改已安装 skill 或宿主信任。Python 需 3.10+，本机验证使用 Homebrew Python 3.13。随后执行 `python3 scripts/wiki_context.py prepare --files <路径...>`，阅读输出列出的页面，再运行 `python3 scripts/wiki_context.py check` 后编辑。修改相关页面后重新 prepare 并阅读，结束时再 check；stamp 证明捕获，不证明阅读或正确性。下面是本仓唯一的路径到 Wiki 路由表，helper 直接读取，不维护第二份清单。

| 路径模式 | 必读页 |
|---|---|
| `docs/plans/2026-11-21-stackchan-software-design.md` | `wiki/runtime.md`, `wiki/device-settings.md`, `wiki/validation.md` |
| `docs/plans/2026-11-21-stackchan-software-plan.md` | `wiki/runtime.md`, `wiki/device-settings.md`, `wiki/validation.md` |
| `scripts/build_whale_avatar.mjs` | `wiki/device-settings.md`, `wiki/firmware-runtime.md`, `wiki/validation.md` |
| `test/whale-avatar-assets.test.mjs` | `wiki/device-settings.md`, `wiki/validation.md` |
| `firmware/agent/whale*` | `wiki/device-settings.md`, `wiki/firmware-runtime.md`, `wiki/validation.md` |
| `firmware/whale-sources/NOTICE.md` | `wiki/device-settings.md`, `wiki/validation.md` |
| `firmware/agent/agent_session*` | `wiki/motion.md` |
| `firmware/agent/agent_network.cc` | `wiki/agent-transport.md`, `wiki/voice-runtime.md`, `wiki/validation.md` |
| `firmware/agent/agent_network_test.cc` | `wiki/agent-transport.md`, `wiki/voice-runtime.md`, `wiki/validation.md` |
| `firmware/agent/device_main.cc` | `wiki/motion.md`, `wiki/dual-boot-updates.md` |
| `firmware/agent/device_trace*` | `wiki/hardware-check.md`, `wiki/voice-runtime.md`, `wiki/validation.md` |
| `firmware/agent/pairing_usb.cc` | `wiki/hardware-check.md`, `wiki/agent-transport.md`, `wiki/validation.md` |
| `firmware/agent/audio_runtime.cc` | `wiki/hardware-check.md`, `wiki/agent-audio.md`, `wiki/validation.md` |
| `scripts/device_trace.py` | `wiki/hardware-check.md`, `wiki/voice-runtime.md`, `wiki/validation.md` |
| `wiki/diagrams/device-diagnostics-sequence.mmd` | `wiki/hardware-check.md`, `wiki/voice-runtime.md`, `wiki/diagrams.md` |
| `firmware/agent/preferences*` | `wiki/motion.md` |
| `src/agent-transport.mjs` | `wiki/motion.md` |
| `src/agent-protocol.mjs` | `wiki/motion.md` |
| `scripts/test_agent_transport.mjs` | `wiki/motion.md` |
| `firmware/tests/vendor/ftservo/**` | `wiki/motion.md` |
| `firmware/agent/motion*` | `wiki/motion.md`, `wiki/device-capabilities.md` |
| `firmware/agent/py32_expander*` | `wiki/motion.md`, `wiki/device-capabilities.md`, `wiki/validation.md` |
| `wiki/diagrams/py32-ring-sequence.mmd` | `wiki/device-capabilities.md`, `wiki/motion.md`, `wiki/diagrams.md` |
| `firmware/agent/ring_*` | `wiki/device-capabilities.md`, `wiki/device-settings.md`, `wiki/motion.md`, `wiki/validation.md` |
| `wiki/diagrams/device-data.mmd` | `wiki/device-settings.md`, `wiki/system-views.md`, `wiki/diagrams.md` |
| `wiki/diagrams/ring-command-sequence.mmd` | `wiki/device-capabilities.md`, `wiki/diagrams.md` |
| `wiki/diagrams/voice-indicator-sequence.mmd` | `wiki/device-capabilities.md`, `wiki/agent-transport.md`, `wiki/diagrams.md` |
| `wiki/diagrams/text-controls-sequence.mmd` | `wiki/device-settings.md`, `wiki/voice-runtime.md`, `wiki/diagrams.md` |
| `wiki/diagrams/lan-standby-sequence.mmd` | `wiki/voice-runtime.md`, `wiki/settings-ui.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `wiki/assets/views/lan-standby-sequence.svg` | `wiki/voice-runtime.md`, `wiki/diagrams.md` |
| `firmware/agent-text-controls-build.json` | `wiki/device-settings.md`, `wiki/independent-agent.md`, `wiki/validation.md` |
| `firmware/agent-interaction-feedback-build.json` | `wiki/device-capabilities.md`, `wiki/independent-agent.md`, `wiki/device-settings.md`, `wiki/validation.md` |
| `firmware/agent-asset-diagnostics-build.json` | `wiki/independent-agent.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `test/bridge.test.mjs` | `wiki/runtime.md`, `wiki/voice-runtime.md`, `wiki/device-capabilities.md` |
| `test/agent-transport.test.mjs` | `wiki/agent-transport.md`, `wiki/device-capabilities.md`, `wiki/validation.md` |
| `src/voice-diagnostics.mjs` | `wiki/voice-runtime.md`, `wiki/agent-transport.md`, `wiki/validation.md` |
| `wiki/diagrams/local-audio-sequence.mmd` | `wiki/local-audio.md`, `wiki/local-voice.md`, `wiki/validation.md` |
| `src/agent-usb-wire.mjs` | `wiki/agent-transport.md`, `wiki/product-plan.md`, `wiki/validation.md` |
| `test/agent-usb-wire.test.mjs` | `wiki/agent-transport.md`, `wiki/agent-pairing.md`, `wiki/validation.md` |
| `wiki/diagrams/agent-transport-sequence.mmd` | `wiki/agent-transport.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `scripts/run_agent_relay.mjs` | `wiki/agent-transport.md`, `wiki/product-plan.md`, `wiki/validation.md` |
| `scripts/prepare_agent_relay.mjs` | `wiki/agent-transport.md`, `wiki/settings-ui.md`, `wiki/product-plan.md`, `wiki/validation.md` |
| `scripts/test_agent_relay_esp.*` | `wiki/agent-transport.md`, `wiki/validation.md` |
| `firmware/tests/relay-probe/**` | `wiki/agent-transport.md`, `wiki/validation.md` |
| `wiki/diagrams/agent-relay-sequence.mmd` | `wiki/agent-transport.md`, `wiki/diagrams.md`, `wiki/product-plan.md` |
| `wiki/diagrams/usb-pairing-sequence.mmd` | `wiki/agent-pairing.md`, `wiki/agent-transport.md`, `wiki/diagrams.md` |
| `wiki/diagrams/relay-setup-sequence.mmd` | `wiki/settings-ui.md`, `wiki/host-pairing.md`, `wiki/diagrams.md` |
| `wiki/diagrams/relay-provision-flow.mmd` | `wiki/agent-transport.md`, `wiki/settings-ui.md`, `wiki/diagrams.md` |
| `wiki/diagrams/voice-runtime-sequence.mmd` | `wiki/voice-runtime.md`, `wiki/settings-ui.md`, `wiki/diagrams.md` |
| `src/usb-*.mjs` | `wiki/agent-transport.md`, `wiki/host-pairing.md`, `wiki/voice-runtime.md`, `wiki/settings-ui.md` |
| `scripts/agent_usb_audio.py` | `wiki/agent-transport.md`, `wiki/host-pairing.md`, `wiki/validation.md` |
| `wiki/diagrams/usb-voice-port-sequence.mmd` | `wiki/agent-transport.md`, `wiki/host-pairing.md`, `wiki/diagrams.md` |
| `wiki/assets/views/usb-voice-port-sequence.svg` | `wiki/host-pairing.md`, `wiki/diagrams.md` |
| `wiki/diagrams/usb-standby-sequence.mmd` | `wiki/agent-transport.md`, `wiki/voice-runtime.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `wiki/assets/views/usb-standby-sequence.svg` | `wiki/voice-runtime.md`, `wiki/diagrams.md` |
| `scripts/*agent_usb_entry.py` | `wiki/dual-boot-updates.md`, `wiki/installation-recovery.md`, `wiki/hardware-check.md`, `wiki/validation.md` |
| `test/usb-serial.test.mjs` | `wiki/agent-transport.md`, `wiki/voice-runtime.md`, `wiki/validation.md` |
| `test/capability-tools.test.mjs` | `wiki/device-capabilities.md`, `wiki/validation.md` |
| `firmware/agent/device_ui_test.cc` | `wiki/device-settings.md`, `wiki/validation.md` |
| `firmware/agent/settings_store_test.cc` | `wiki/device-settings.md`, `wiki/validation.md` |
| `firmware/agent/preferences_test.cc` | `wiki/device-settings.md`, `wiki/validation.md` |
| `scripts/test_agent.py` | `wiki/independent-agent.md`, `wiki/device-capabilities.md`, `wiki/validation.md` |
| `firmware/agent/ring_port*` | `wiki/device-capabilities.md`, `wiki/motion.md`, `wiki/validation.md` |
| `firmware/agent/component.cmake` | `wiki/independent-agent.md`, `wiki/device-capabilities.md` |
| `scripts/test_agent_motion.py` | `wiki/motion.md`, `wiki/validation.md` |
| `src/camera-attachment.mjs` | `wiki/camera.md` |
| `test/camera-attachment.test.mjs` | `wiki/camera.md` |
| `src/device-capabilities.mjs` | `wiki/device-capabilities.md`, `wiki/voice-runtime.md`, `wiki/settings-ui.md`, `wiki/validation.md` |
| `wiki/diagrams/device-capability-*.mmd` | `wiki/device-capabilities.md`, `wiki/diagrams.md`, `wiki/system-views.md` |
| `wiki/diagrams/deployment.mmd` | `wiki/system-views.md`, `wiki/diagrams.md`, `wiki/hardware-check.md` |
| `wiki/diagrams/boot-selection-state.mmd` | `wiki/dual-boot-updates.md`, `wiki/hardware-check.md`, `wiki/diagrams.md` |
| `wiki/diagrams/maintenance-deployment.mmd` | `wiki/installation-recovery.md`, `wiki/hardware-check.md`, `wiki/dual-boot-updates.md`, `wiki/diagrams.md`, `wiki/system-views.md` |
| `test/packaged-plugin.test.mjs` | `wiki/settings-ui.md`, `wiki/device-capabilities.md`, `wiki/validation.md` |
| `src/capability-tools.mjs` | `wiki/camera.md` |
| `src/voice-runtime.mjs` | `wiki/camera.md` |
| `src/agent-camera.mjs` | `wiki/camera.md`, `wiki/agent-transport.md` |
| `firmware/agent/agent_*` | `wiki/camera.md` |
| `test/agent-camera.test.mjs` | `wiki/camera.md`, `wiki/agent-transport.md` |
| `firmware/agent/camera*` | `wiki/camera.md`, `wiki/device-capabilities.md` |
| `scripts/test_agent_camera.py` | `wiki/camera.md`, `wiki/validation.md` |
| `firmware/agent-capacity-review.json` | `wiki/installation-recovery.md`, `wiki/validation.md` |
| `firmware/boot-selector/**` | `wiki/dual-boot-updates.md`, `wiki/installation-recovery.md`, `wiki/manual-alignment.md`, `wiki/validation.md` |
| `firmware/menu-entry/**` | `wiki/app-center.md`, `wiki/dual-boot-updates.md`, `wiki/independent-agent.md`, `wiki/installation-recovery.md`, `wiki/manual-alignment.md`, `wiki/validation.md` |
| `scripts/export_agent_menu_review.py` | `wiki/app-center.md`, `wiki/independent-agent.md`, `wiki/validation.md` |
| `scripts/export_app_center_review.py` | `wiki/app-center.md`, `wiki/product-plan.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `contributions/m5stack-stackchan-launcher/**` | `wiki/app-center.md`, `wiki/product-plan.md`, `wiki/validation.md` |
| `contributions/m5stack-app-center-reopen/**` | `wiki/app-center.md`, `wiki/product-plan.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `contributions/m5stack-app-center-home/**` | `wiki/app-center.md`, `wiki/product-plan.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `contributions/m5stack-app-center-shortcut/**` | `wiki/app-center.md`, `wiki/product-plan.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `firmware/tests/app-center-reopen/**` | `wiki/app-center.md`, `wiki/dual-boot-updates.md`, `wiki/validation.md` |
| `scripts/audit_app_center_reopen.py` | `wiki/app-center.md`, `wiki/dual-boot-updates.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `wiki/diagrams/app-center-reopen-sequence.mmd` | `wiki/app-center.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `scripts/prepare_agent_menu.py` | `wiki/app-center.md`, `wiki/independent-agent.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/test_agent_menu.py` | `wiki/app-center.md`, `wiki/validation.md` |
| `scripts/test_agent_menu_source.py` | `wiki/app-center.md`, `wiki/independent-agent.md`, `wiki/validation.md` |
| `scripts/audit_agent_menu_qemu.py` | `wiki/app-center.md`, `wiki/dual-boot-updates.md`, `wiki/validation.md` |
| `scripts/audit_agent_menu_recovery.py` | `wiki/app-center.md`, `wiki/independent-agent.md`, `wiki/installation-recovery.md`, `wiki/dual-boot-updates.md`, `wiki/manual-alignment.md`, `wiki/validation.md` |
| `firmware/tests/app-center-return/**` | `wiki/app-center.md`, `wiki/dual-boot-updates.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/audit_app_center_return.py` | `wiki/app-center.md`, `wiki/dual-boot-updates.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `firmware/tests/app-center-storage/**` | `wiki/app-center.md`, `wiki/agent-pairing.md`, `wiki/device-settings.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/audit_app_center_storage.py` | `wiki/app-center.md`, `wiki/device-settings.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `firmware/tests/app-center-home/**` | `wiki/app-center.md`, `wiki/dual-boot-updates.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `firmware/agent-app-center-home-build.json` | `wiki/app-center.md`, `wiki/independent-agent.md`, `wiki/validation.md` |
| `firmware/agent-app-center-dual-slot-build.json` | `wiki/app-center.md`, `wiki/independent-agent.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `firmware/agent-head-touch-quiet-ota-build.json` | `wiki/app-center.md`, `wiki/device-capabilities.md`, `wiki/independent-agent.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `firmware/agent-ip-change-v55-build.json` | `wiki/agent-transport.md`, `wiki/independent-agent.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/audit_app_center_home.py` | `wiki/app-center.md`, `wiki/dual-boot-updates.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/audit_app_center_cycles.py` | `wiki/app-center.md`, `wiki/dual-boot-updates.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/audit_app_center_shortcut.py` | `wiki/app-center.md`, `wiki/product-plan.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `wiki/diagrams/app-center-home-sequence.mmd` | `wiki/app-center.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `firmware/app-center/**` | `wiki/app-center.md`, `wiki/device-settings.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/app_center_baseline.py` | `wiki/app-center.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/inspect_backup.py` | `wiki/hardware-check.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/prepare_installation.py` | `wiki/hardware-check.md`, `wiki/dual-boot-updates.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/audit_app_center_agent.py` | `wiki/app-center.md`, `wiki/independent-agent.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `firmware/agent-stock-trial-v54-build.json` | `wiki/independent-agent.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `wiki/diagrams/stock-trial-sequence.mmd` | `wiki/installation-recovery.md`, `wiki/validation.md`, `wiki/diagrams.md` |
| `scripts/audit_app_center_ota_writer.py` | `wiki/app-center.md`, `wiki/dual-boot-updates.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/review_app_center_recovery.py` | `wiki/app-center.md`, `wiki/dual-boot-updates.md`, `wiki/hardware-check.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/test_review_app_center_recovery.py` | `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/ota_record.py` | `wiki/dual-boot-updates.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/*review_app_center_install.py` | `wiki/app-center.md`, `wiki/dual-boot-updates.md`, `wiki/hardware-check.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/*review_stock_trial_install.py` | `wiki/dual-boot-updates.md`, `wiki/hardware-check.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/execute_stock_trial.py` | `wiki/app-center.md`, `wiki/hardware-check.md`, `wiki/installation-recovery.md`, `wiki/manual-alignment.md`, `wiki/validation.md` |
| `scripts/prepare_stock_trial_debug.py` | `wiki/device-compatibility.md`, `wiki/hardware-check.md`, `wiki/independent-agent.md`, `wiki/validation.md` |
| `wiki/diagrams/app-center-install-review.mmd` | `wiki/installation-recovery.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `wiki/assets/views/app-center-install-review.svg` | `wiki/installation-recovery.md`, `wiki/diagrams.md` |
| `wiki/diagrams/app-center-recovery-review.mmd` | `wiki/installation-recovery.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `wiki/diagrams/app-center-shortcut-sequence.mmd` | `wiki/app-center.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `wiki/assets/views/app-center-shortcut-sequence.svg` | `wiki/app-center.md`, `wiki/diagrams.md` |
| `firmware/tests/app-center-ota-writer/**` | `wiki/app-center.md`, `wiki/dual-boot-updates.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `wiki/diagrams/app-center-ota-writer-sequence.mmd` | `wiki/app-center.md`, `wiki/dual-boot-updates.md`, `wiki/installation-recovery.md`, `wiki/validation.md`, `wiki/diagrams.md` |
| `wiki/diagrams/touch-menu-entry-sequence.mmd` | `wiki/app-center.md`, `wiki/dual-boot-updates.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `wiki/diagrams/app-center-stock-state.mmd` | `wiki/app-center.md`, `wiki/installation-recovery.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `wiki/assets/views/app-center-stock-state.svg` | `wiki/app-center.md`, `wiki/diagrams.md` |
| `scripts/build_agent_selector.py` | `wiki/dual-boot-updates.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/test_agent_selector.py` | `wiki/dual-boot-updates.md`, `wiki/validation.md` |
| `scripts/audit_agent_qemu.py` | `wiki/dual-boot-updates.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `wiki/diagrams/isolated-slot-sequence.mmd` | `wiki/dual-boot-updates.md`, `wiki/installation-recovery.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `scripts/audit_ota_selection.py` | `wiki/dual-boot-updates.md`, `wiki/validation.md` |
| `scripts/capture_agent_preflight.py` | `wiki/installation-recovery.md`, `wiki/hardware-check.md`, `wiki/manual-alignment.md`, `wiki/validation.md` |
| `scripts/check_agent_preflight.py` | `wiki/installation-recovery.md`, `wiki/hardware-check.md`, `wiki/validation.md` |
| `scripts/check_stock_nvs.py` | `wiki/installation-recovery.md`, `wiki/hardware-check.md`, `wiki/validation.md` |
| `scripts/test_agent_preflight.py` | `wiki/installation-recovery.md`, `wiki/hardware-check.md`, `wiki/validation.md` |
| `scripts/execute_agent_bundle.py` | `wiki/installation-recovery.md`, `wiki/hardware-check.md`, `wiki/manual-alignment.md`, `wiki/validation.md` |
| `scripts/test_execute_agent_bundle.py` | `wiki/installation-recovery.md`, `wiki/validation.md` |
| `wiki/diagrams/install-recovery-sequence.mmd` | `wiki/installation-recovery.md`, `wiki/diagrams.md` |
| `scripts/prepare_agent_bundle.py` | `wiki/installation-recovery.md`, `wiki/dual-boot-updates.md`, `wiki/manual-alignment.md`, `wiki/validation.md` |
| `scripts/test_agent_bundle.py` | `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/audit_agent_layout.py` | `wiki/installation-recovery.md`, `wiki/dual-boot-updates.md`, `wiki/validation.md` |
| `scripts/test_agent_layout.py` | `wiki/installation-recovery.md`, `wiki/dual-boot-updates.md`, `wiki/validation.md` |
| `scripts/review_agent_capacity.py` | `wiki/installation-recovery.md`, `wiki/independent-agent.md` |
| `scripts/test_agent_capacity.py` | `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/test_agent_display.py` | `wiki/independent-agent.md`, `wiki/device-settings.md`, `wiki/validation.md` |
| `src/capability-tools.mjs` | `wiki/device-capabilities.md`, `wiki/settings-ui.md`, `wiki/voice-runtime.md` |
| `test/capability-tools.test.mjs` | `wiki/device-capabilities.md`, `wiki/validation.md` |
| `firmware/agent/expression*` | `wiki/device-capabilities.md`, `wiki/independent-agent.md` |
| `src/voice-installation.mjs` | `wiki/voice-installation.md`, `wiki/voice-environment.md`, `wiki/voice-runtime.md` |
| `scripts/prepare_voice_installation.py` | `wiki/voice-installation.md`, `wiki/local-speech.md`, `wiki/local-audio.md` |
| `scripts/test_prepare_voice_installation.py` | `wiki/voice-installation.md`, `wiki/validation.md` |
| `test/voice-installation.test.mjs` | `wiki/voice-installation.md`, `wiki/voice-environment.md`, `wiki/validation.md` |
| `src/voice-environment.mjs` | `wiki/voice-environment.md`, `wiki/voice-runtime.md`, `wiki/local-speech.md`, `wiki/local-audio.md` |
| `scripts/voice_environment.py` | `wiki/voice-environment.md`, `wiki/local-speech.md` |
| `test/voice-environment.test.mjs` | `wiki/voice-environment.md`, `wiki/validation.md` |
| `wiki/diagrams/voice-preview-sequence.mmd` | `wiki/voice-environment.md`, `wiki/settings-ui.md`, `wiki/diagrams.md` |
| `src/settings-voice-*.mjs` | `wiki/voice-environment.md`, `wiki/voice-installation.md`, `wiki/voice-runtime.md`, `wiki/settings-ui.md` |
| `scripts/*dsh_native_voice*.mjs` | `wiki/voice-runtime.md`, `wiki/runtime-sequences.md`, `wiki/local-voice.md`, `wiki/settings-ui.md`, `wiki/camera.md`, `wiki/validation.md` |
| `scripts/test_dsh_native_voice.mjs` | `wiki/voice-runtime.md`, `wiki/agent-transport.md`, `wiki/validation.md` |
| `scripts/usb_trial_control.mjs` | `wiki/installation-recovery.md`, `wiki/voice-runtime.md`, `wiki/hardware-check.md`, `wiki/validation.md` |
| `scripts/test_dsh_native_device.mjs` | `wiki/voice-runtime.md`, `wiki/agent-transport.md`, `wiki/validation.md` |
| `firmware/agent/agent_session_test.cc` | `wiki/voice-runtime.md`, `wiki/agent-transport.md`, `wiki/validation.md` |
| `scripts/test_dsh_native_voice_usb_pty.py` | `wiki/agent-pairing.md`, `wiki/host-pairing.md`, `wiki/agent-transport.md`, `wiki/voice-runtime.md`, `wiki/validation.md` |
| `scripts/*voice_latency.py` | `wiki/product-plan.md`, `wiki/voice-runtime.md`, `wiki/validation.md` |
| `scripts/benchmark_whisper.mjs` | `wiki/local-speech.md`, `wiki/product-plan.md`, `wiki/voice-runtime.md`, `wiki/validation.md` |
| `vendor/voice/whisper-worker/**` | `wiki/local-speech.md`, `wiki/voice-installation.md`, `wiki/voice-environment.md`, `wiki/validation.md` |
| `wiki/diagrams/acoustic-latency-flow.mmd` | `wiki/product-plan.md`, `wiki/voice-runtime.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `wiki/diagrams/ambient-state-sequence.mmd` | `wiki/device-capabilities.md`, `wiki/agent-transport.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `firmware/agent/ambient_*` | `wiki/device-capabilities.md`, `wiki/agent-transport.md`, `wiki/validation.md` |
| `firmware/agent/si12t*` | `wiki/device-capabilities.md`, `wiki/agent-transport.md`, `wiki/validation.md` |
| `firmware/agent/head_touch_gestures*` | `wiki/device-capabilities.md`, `wiki/agent-transport.md`, `wiki/validation.md` |
| `wiki/diagrams/head-touch-gesture-sequence.mmd` | `wiki/device-capabilities.md`, `wiki/agent-transport.md`, `wiki/diagrams.md` |
| `firmware/agent-head-gestures-build.json` | `wiki/independent-agent.md`, `wiki/device-capabilities.md`, `wiki/validation.md` |
| `firmware/agent/bmi270_agent*` | `wiki/device-capabilities.md`, `wiki/agent-transport.md`, `wiki/validation.md` |
| `firmware/agent-imu-build.json` | `wiki/independent-agent.md`, `wiki/device-capabilities.md`, `wiki/validation.md` |
| `firmware/agent-face-touch-build.json` | `wiki/device-settings.md`, `wiki/independent-agent.md`, `wiki/validation.md` |
| `firmware/agent-head-touch-build.json` | `wiki/independent-agent.md`, `wiki/device-capabilities.md`, `wiki/validation.md` |
| `wiki/diagrams/camera-attachment-sequence.mmd` | `wiki/camera.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `wiki/diagrams/plugin-load-sequence.mmd` | `wiki/settings-ui.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `wiki/diagrams/settings-sequence.mmd` | `wiki/settings-ui.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `src/dsh-session.mjs` | `wiki/runtime.md`, `wiki/runtime-sequences.md`, `wiki/settings-ui.md`, `wiki/validation.md` |
| `wiki/diagrams/conversation-sequence.mmd` | `wiki/runtime-sequences.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `wiki/diagrams/local-voice-sequence.mmd` | `wiki/local-voice.md`, `wiki/local-speech.md`, `wiki/device-settings.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `wiki/diagrams/local-speech-sequence.mmd` | `wiki/local-speech.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `wiki/diagrams/voice-installation-sequence.mmd` | `wiki/voice-installation.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `test/voice-runtime.test.mjs` | `wiki/voice-runtime.md`, `wiki/voice-installation.md`, `wiki/validation.md` |
| `test/pairing-identity.test.mjs` | `wiki/voice-runtime.md`, `wiki/host-pairing.md` |
| `test/settings-voice.test.mjs` | `wiki/voice-runtime.md`, `wiki/voice-installation.md`, `wiki/settings-ui.md` |
| `src/voice-runtime.mjs` | `wiki/device-capabilities.md`, `wiki/voice-runtime.md`, `wiki/voice-installation.md`, `wiki/local-voice.md`, `wiki/settings-ui.md`, `wiki/host-pairing.md` |
| `test/local-speech.test.mjs` | `wiki/local-speech.md`, `wiki/validation.md` |
| `src/pairing-identity.mjs` | `wiki/voice-runtime.md`, `wiki/host-pairing.md` |
| `scripts/agent_pairing_identity.py` | `wiki/voice-runtime.md`, `wiki/host-pairing.md` |
| `src/local-voice.mjs` | `wiki/local-voice.md`, `wiki/runtime.md`, `wiki/agent-transport.md`, `wiki/local-speech.md` |
| `test/local-voice.test.mjs` | `wiki/local-voice.md`, `wiki/voice-runtime.md`, `wiki/validation.md` |
| `wiki/diagrams/standby-synthesis-state.mmd` | `wiki/local-voice.md`, `wiki/voice-runtime.md`, `wiki/diagrams.md` |
| `wiki/assets/views/standby-synthesis-state.svg` | `wiki/local-voice.md`, `wiki/diagrams.md` |
| `scripts/local_audio.py` | `wiki/local-audio.md`, `wiki/agent-transport.md` |
| `src/local-audio.mjs` | `wiki/local-audio.md` |
| `test/local-audio.test.mjs` | `wiki/local-audio.md`, `wiki/validation.md` |
| `scripts/prepare_audio.py` | `wiki/local-audio.md`, `wiki/local-speech.md` |
| `scripts/test_local_audio.py` | `wiki/local-audio.md`, `wiki/validation.md` |
| `vendor/audio/**` | `wiki/local-audio.md` |
| `src/local-*.mjs` | `wiki/local-speech.md`, `wiki/runtime.md`, `wiki/agent-transport.md` |
| `scripts/local_speech.py` | `wiki/local-speech.md`, `wiki/local-voice-options.md` |
| `scripts/prepare_voice.py` | `wiki/local-speech.md`, `wiki/settings-ui.md` |
| `vendor/voice/**` | `wiki/local-speech.md`, `wiki/settings-ui.md` |
| `src/agent-*.mjs` | `wiki/device-capabilities.md`, `wiki/agent-transport.md`, `wiki/agent-audio.md`, `wiki/agent-pairing.md`, `wiki/runtime.md` |
| `src/plugin.mjs` | `wiki/device-capabilities.md`, `wiki/settings-ui.md`, `wiki/runtime.md`, `wiki/voice-runtime.md` |
| `src/settings-*.mjs` | `wiki/settings-ui.md`, `wiki/runtime.md` |
| `scripts/build_plugin.mjs` | `wiki/settings-ui.md` |
| `package-lock.json` | `wiki/settings-ui.md` |
| `.github/workflows/*` | `wiki/settings-ui.md`, `wiki/validation.md` |
| `package.json` | `wiki/settings-ui.md` |
| `cordis.patch.yml` | `wiki/settings-ui.md` |
| `client/**` | `wiki/settings-ui.md` |
| `src/bridge.mjs` | `wiki/independent-agent.md`, `wiki/manual-alignment.md`, `wiki/runtime.md`, `wiki/voice-runtime.md` |
| `src/host.mjs` | `wiki/independent-agent.md`, `wiki/design.md`, `wiki/settings-ui.md` |
| `test/*` | `wiki/independent-agent.md`, `wiki/validation.md` |
| `firmware/agent-*-build.json` | `wiki/independent-agent.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `firmware/agent-dependencies.lock` | `wiki/agent-transport.md`, `wiki/independent-agent.md`, `wiki/installation-recovery.md` |
| `firmware/agent/agent_*` | `wiki/device-capabilities.md`, `wiki/agent-transport.md`, `wiki/agent-audio.md`, `wiki/agent-pairing.md` |
| `scripts/test_agent_transport.mjs` | `wiki/agent-transport.md`, `wiki/agent-audio.md`, `wiki/runtime-sequences.md`, `wiki/local-voice.md`, `wiki/validation.md` |
| `wiki/diagrams/stop-sequence.mmd` | `wiki/runtime-sequences.md`, `wiki/agent-audio.md`, `wiki/diagrams.md` |
| `wiki/diagrams/device-state.mmd` | `wiki/runtime-sequences.md`, `wiki/agent-transport.md`, `wiki/diagrams.md`, `wiki/validation.md` |
| `firmware/agent/pairing*` | `wiki/agent-pairing.md`, `wiki/pairing.md` |
| `firmware/tests/vendor/**` | `wiki/agent-pairing.md` |
| `firmware/NOTICE.md` | `wiki/agent-pairing.md` |
| `firmware/agent/**` | `wiki/device-settings.md`, `wiki/independent-agent.md`, `wiki/manual-alignment.md`, `wiki/installation-recovery.md` |
| `firmware/agent/audio*` | `wiki/agent-audio.md` |
| `firmware/agent/core_audio*` | `wiki/agent-audio.md` |
| `firmware/agent/device_main.cc` | `wiki/device-capabilities.md`, `wiki/agent-audio.md`, `wiki/settings-ui.md`, `wiki/device-compatibility.md` |
| `scripts/test_agent.py` | `wiki/device-capabilities.md`, `wiki/independent-agent.md` |
| `scripts/prepare_agent.py` | `wiki/independent-agent.md`, `wiki/installation-recovery.md`, `wiki/agent-audio.md`, `wiki/camera.md` |
| `firmware/agent-power-state-build.json` | `wiki/independent-agent.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/build_agent.py` | `wiki/independent-agent.md`, `wiki/installation-recovery.md` |
| `scripts/audit_agent_rebuild.py` | `wiki/independent-agent.md`, `wiki/installation-recovery.md`, `wiki/validation.md` |
| `scripts/probe_agent_sensor_capacity.py` | `wiki/device-capabilities.md`, `wiki/independent-agent.md`, `wiki/product-plan.md`, `wiki/validation.md` |
| `scripts/prepare_wiki_hook.py` | `wiki/development-workflow.md` |
| `scripts/wiki_context.py` | `wiki/development-workflow.md` |
| `scripts/render_diagrams.py` | `wiki/diagrams.md` |
| `wiki/relationships.json` | `wiki/diagrams.md`, `wiki/local-speech.md`, `wiki/voice-installation.md` |
| `scripts/agent_pairing_usb.py` | `wiki/agent-pairing.md`, `wiki/manual-alignment.md` |
| `firmware/overlay/sion/pairing_config.h` | `wiki/agent-pairing.md`, `wiki/agent-transport.md` |
| `src/pairing.mjs` | `wiki/host-pairing.md`, `wiki/agent-transport.md` |
| `scripts/pairing.mjs` | `wiki/host-pairing.md` |
| `test/pairing-tls.test.mjs` | `wiki/host-pairing.md`, `wiki/validation.md` |
| `scripts/test_agent_pairing_usb.py` | `wiki/agent-pairing.md` |
| `scripts/agent_pairing_host.py` | `wiki/host-pairing.md`, `wiki/agent-pairing.md`, `wiki/settings-ui.md` |
| `scripts/test_agent_pairing_host.py` | `wiki/host-pairing.md`, `wiki/agent-pairing.md`, `wiki/settings-ui.md` |
| `wiki/diagrams/device-network-sequence.mmd` | `wiki/agent-transport.md`, `wiki/diagrams.md`, `wiki/device-settings.md` |
| `wiki/diagrams/sion-modes-architecture.mmd` | `wiki/product-plan.md`, `wiki/diagrams.md`, `wiki/settings-ui.md`, `wiki/agent-transport.md`, `wiki/device-settings.md` |
| `wiki/diagrams/environment-flow.mmd` | `wiki/host-pairing.md`, `wiki/diagrams.md`, `wiki/voice-runtime.md` |
| `wiki/diagrams/managed-usb-pairing-flow.mmd` | `wiki/host-pairing.md`, `wiki/agent-pairing.md`, `wiki/diagrams.md` |
| `wiki/diagrams/pairing-ui-sequence.mmd` | `wiki/host-pairing.md`, `wiki/diagrams.md` |
| `test/pairing-host.test.mjs` | `wiki/host-pairing.md`, `wiki/validation.md` |
| `test/pairing-remote.test.mjs` | `wiki/host-pairing.md`, `wiki/validation.md` |
| `test/settings-pairing.test.mjs` | `wiki/host-pairing.md`, `wiki/settings-ui.md`, `wiki/validation.md` |
| `src/pairing-host.mjs` | `wiki/host-pairing.md`, `wiki/agent-pairing.md`, `wiki/settings-ui.md` |
| `src/remote-api/**` | `wiki/host-pairing.md`, `wiki/settings-ui.md` |
| `scripts/build_remote.mjs` | `wiki/host-pairing.md`, `wiki/settings-ui.md` |
| `lib/**` | `wiki/host-pairing.md`, `wiki/settings-ui.md` |
| `scripts/agent_environment.py` | `wiki/host-pairing.md`, `wiki/settings-ui.md` |
| `scripts/test_agent_environment.py` | `wiki/host-pairing.md`, `wiki/settings-ui.md` |
| `src/runtime-setup.mjs` | `wiki/runtime-installation.md`, `wiki/host-pairing.md`, `wiki/settings-ui.md` |
| `src/managed-pairing.mjs` | `wiki/runtime-installation.md`, `wiki/host-pairing.md`, `wiki/settings-ui.md` |
| `scripts/prepare_runtime.py` | `wiki/runtime-installation.md`, `wiki/host-pairing.md`, `wiki/settings-ui.md` |
| `scripts/test_prepare_runtime.py` | `wiki/runtime-installation.md`, `wiki/host-pairing.md`, `wiki/settings-ui.md` |
| `vendor/pyserial/**` | `wiki/runtime-installation.md`, `wiki/host-pairing.md` |

未命中的路径必须先增加路由，不用通用顶层页掩盖缺口。hook 脚本从锁定官方自研仓获取到忽略的 .local/wiki-hooks 目录；运行前核对 SHA。当前 skill 插件的 PreToolUse 只为 Claude 声明，Codex 自动编辑 hook 未验证。本仓可显式执行同一 gate，并通过 npm run wiki:check 调用本地上下文检查；不声称宿主自动 hook 已启用。SessionStart 的 packet 需要 Git HEAD，本仓尚无提交，因此不伪造 packet 或创建无关提交。宿主加载/信任必须使用其正常流程，不能写 trust 记录冒充启用。

当前检查的限制：只覆盖本次声明的文件和 Wiki 页面；不替代所有代码依赖分析，不执行页面里的命令，不连接设备。CLI/CI 与宿主自动触发分别记录。没有变更上下文的全新 CI 环境仅运行测试与文档结构检查，不假装通过本机上下文检查。

## 开发存储与归档

这台 Mac 的 `work/active/` 指向外置 APFS SSD 上的 `Codex-Dev/DSH-StackChan/work/active/`。开始新的固件构建前确认这个路径可读写，给 `prepare_agent.py --destination` 和 `build_agent.py --source` 传入同一个有版本名的目录。原有工作路径通过链接继续访问已迁移的 SDK、QEMU 和历史固件构建。SSD 离线时，这些路径随之离线。

外置 HDD 的 `Codex-Archive/DSH-StackChan/` 保存工具安装下载包与压缩归档。`work/idf-tools/dist` 指向 HDD 的 `esp-idf-downloads/`，已经解包的工具从 SSD 运行。不常访问的 v35 两份复现构建存于 `firmware-build-archives/v35-verification-builds.tar.zst`。同目录的收据记录压缩文件以及解压后 tar 流的 SHA-256。归档内的 `repro-checkout` 和 `repro-second-checkout` 可还原到 `work/v35-clean-rebuild-verified/`，核对历史比较或继续使用时按需取出。

完成一个构建批次后，保留冻结输入、发布用的 `.bin`、需要诊断的 ELF/map 及相关收据。清理本次确认可重建的编译中间目录和废弃的临时配置档。归档需要保留的旧目录时，先对压缩读回做校验，再回收原副本。原厂 Flash 双读、实体配对记录与用户会话资料仍放在私有本机目录。 [安装与恢复证据](installation-recovery.md)

本次空间回收涉及 52 套历史构建。按收据核对镜像、ELF 和配置后，清除了约 22.5 GiB 可重建的编译对象和中间库，随后再次核对发布产物、分区表、启动器和 map 的摘要。新构建用 `work/active/` 开独立目录，旧构建的中间文件从锁定输入重建。另回收了五代未被活动指针引用的隔离语音环境，约 5.1 GiB，保留了活动环境及失败诊断日志。

2026-11-26 第二次瘦身：`work/` 下 221 个旧构建（v15–v73 时期）只保留产物——固件 `.bin`、ELF、map、sdkconfig、日志、JSON 收据、截图和录音，共 11.5 GB，逐个文件 SHA-256 核对后放到外接 SSD 上的归档目录 `work-archive/`；原位置改成指向那里的软链接，旧路径照常能打开。删掉的是约 49.8 GB 编译中间文件、复制的源码树和工具链副本，删除前又核对了一遍归档。每个条目旁边有 `<名字>.ARCHIVE-MANIFEST.json`，列出保留文件的大小和摘要，以及删掉了多少。构建仍用的目录（`idf-tools`、`esp-idf-stock-v5.5.4`、`firmware-build`、`host-tests` 等）留在内置盘。外接 SSD 没插上时，这些旧路径打不开，但不影响构建和测试。

## 图示编写与变更复审

依据 [WikiSkill #72](https://github.com/sairaisaika/projectWikiSkill/pull/72) 和 [图示编写规范](https://github.com/sairaisaika/projectWikiSkill/blob/8f7b049ac52b9e4b38ac1cff95208f6af83d4c2d/project-wiki/references/diagram-framework.md#author-at-project-section-and-page-scope) 维护 [六类图示](diagrams.md)。项目入口展示责任架构，新系统边界或跨角色章节先写清要回答的问题并选图。接口调用用时序，业务分支用流程，事件与守卫用状态，持久记录用数据模型，进程和连接用部署。导航页沿用功能页的图。

每张图在所属章节写出问题、结论、适用场景、源码和当前验证状态。修改代码时用上面的路径路由定位功能章节，核对实际 diff 涉及的图，记录「已更新」「已核对无需更新」或「待核对」。本仓保留 .mmd 与已经渲染的 SVG，采用原生路径路由和人工图示审核。WikiSkill 的 schema-2 Mermaid 围栏检查适用于选择该格式的项目。

更改 Mermaid 后用本仓渲染器重新生成 SVG，打开图检查标签、裁切以及错误与取消分支。图示导航变更检查章节锚点和原图可达性。显式 Wiki gate 检查上下文及字节新鲜度，语义和图片是否实际显示在审核时验证。

## 开发收尾与续做

在当前功能页写入长期规则，在 [验证记录](validation.md) 留下复现实验、证据和待验收条件。停在真机前时记录候选及上次可恢复的设备状态。只检查本次已知的脚本、日志、配置档、测试进程与构建产物，保留下一步所需的证据，把可重建留存按 [开发存储与归档](#开发存储与归档) 管理。最终再次运行现有 Wiki 检查。 [上游收尾入口](https://github.com/sairaisaika/projectWikiSkill/blob/71c9c2301679abc096c94e7e5d95f1eec45ba1bd/project-wiki/references/maintenance.md#closeout-and-maintenance-sweeps)

## 显式门禁状态

本仓启用 page_hashes，Wiki 任一选定页面改动会使 context 失效；门禁脚本及配置的哈希也绑定本次捕获。尚无 Git HEAD，design_first=false，设计先行由本轮实际页面审查保障。上游 0.2.39（`71c9c23`）加入开发收尾和存储盘点。2026-11-20 将本机 skill 文件和项目固定门禁对齐到该提交，显式调用仍为本仓使用方式。 [上游更新](https://github.com/sairaisaika/projectWikiSkill/pull/73)

PR #71 已合并（bd5bbf0）。本仓仍使用先前审查并固定的 gate 版本。图示复审采用已合并的 #72 规范，并通过本仓原生路径路由执行。
