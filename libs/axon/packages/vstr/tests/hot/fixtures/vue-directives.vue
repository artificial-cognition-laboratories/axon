<template>
    <div>
        <p v-if="a">branch-alpha</p>
        <p v-else-if="b">branch-beta</p>
        <p v-else>branch-gamma</p>
        <ul>
            <li v-for="(item, i) in items" :key="i">{{ i }}:{{ item }}</li>
        </ul>
        <p v-show="visible">ShowTarget</p>
        <p :data-cls="cls">BoundTarget</p>
    </div>
</template>

<script setup lang="ts">
const { a = false, b = false, items = [], visible = true, cls = "" } = defineProps<{
    a?: boolean
    b?: boolean
    items?: string[]
    visible?: boolean
    cls?: string
}>()
</script>
