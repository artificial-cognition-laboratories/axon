import { DIRECT_PROVIDERS } from "../../../src/aisdk"

const models = []
for (const [name, definition] of Object.entries(DIRECT_PROVIDERS)) {
    const create = await definition.load("fixture-key-never-sent")
    const model = create("fixture-model")
    if (model.specificationVersion !== "v4" || typeof model.doStream !== "function") throw new Error(`Invalid shipped SDK: ${name}`)
    models.push(name)
}
console.log(JSON.stringify(models.sort()))
