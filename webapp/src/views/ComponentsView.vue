<script setup lang="ts">
// Ship components: the stock view over the components (its own route component, so switching
// between the two tabs mounts it anew)
import StockView from "./StockView.vue";
</script>

<template>
  <StockView components />
</template>
