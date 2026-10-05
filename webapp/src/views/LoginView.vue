<script setup lang="ts">
// Not logged in: the Discord login (a plain link: the server redirects to Discord and back).
import logo from "../../../web/src/assets/logo-128.png";
import { t } from "../i18n";
import { loginNotice } from "../session";
</script>

<template>
  <div class="login">
    <div class="panel card">
      <img class="logo" :src="logo" alt="" />
      <div class="wordmark">QUARTER<span class="accent">MASTER</span></div>
      <div class="dim">{{ t("app.tagline") }}</div>
      <div v-if="loginNotice" class="warning">{{ t(loginNotice === "failed" ? "login.failed" : "login.denied") }}</div>
      <a class="btn primary" href="/auth/login">{{ t("login.button") }}</a>
      <div class="faint hint">{{ t("login.hint") }}</div>
    </div>
  </div>
</template>

<style scoped>
.login {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}

.card {
  align-items: center;
  gap: 14px;
  padding: 32px 28px;
  max-width: 360px;
  width: 100%;
  text-align: center;
}

.logo {
  width: 64px;
  height: 64px;
}

.wordmark {
  font-weight: 700;
  font-size: 20px;
  letter-spacing: 0.22em;
}

.wordmark .accent {
  color: var(--accent);
}

.btn {
  width: 100%;
  text-decoration: none;
}

.btn:hover {
  text-decoration: none;
}

.hint {
  font-size: 12px;
}
</style>
