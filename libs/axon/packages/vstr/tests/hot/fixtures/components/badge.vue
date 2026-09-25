<template>
    <span>badge:{{ label }}</span>
</template>

<script setup lang="ts">
const { label = "default" } = defineProps<{ label?: string }>()
</script>
