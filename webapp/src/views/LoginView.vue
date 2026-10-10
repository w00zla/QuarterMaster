<script setup lang="ts">
// Not logged in: the Discord login (a plain link: the server redirects to Discord and back, then to
// the page opened, e.g. a deep link from the bot).
import logo from "../assets/logo-256.png";
import { t } from "../i18n";
import { loginNotice } from "../session";

const loginUrl = `/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`;
</script>

<template>
  <div class="login">
    <div class="panel card">
      <img class="logo" :src="logo" alt="" />
      <div class="wordmark">QUARTER<span class="accent">MASTER</span></div>
      <div class="tagline">
        <div class="dim">{{ t("app.tagline") }}</div>
        <div class="slogan">{{ t("app.slogan") }}</div>
      </div>
      <div v-if="loginNotice" class="warning">{{ t(loginNotice === "failed" ? "login.failed" : "login.denied") }}</div>
      <a class="btn primary" :href="loginUrl">{{ t("login.button") }}</a>
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
  /* The login's centrepiece; the file has twice the pixels for HiDPI screens */
  width: 112px;
  height: 112px;
}

.wordmark {
  font-weight: 700;
  font-size: 20px;
  letter-spacing: 0.22em;
}

.wordmark .accent {
  color: var(--accent);
}

.tagline {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.slogan {
  font-style: italic;
  font-size: 13px;
  color: var(--text-3);
}

/* As wide as its text (the card centers it), with room around it */
.btn {
  height: 44px;
  padding: 0 32px;
  margin: 12px 0;
  text-decoration: none;
}

.btn:hover {
  text-decoration: none;
}

.hint {
  font-size: 12px;
}
</style>
