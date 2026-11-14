import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { Launch } from "../../src/labs/minecraft/launch"

const roots: string[] = []

async function put(path: string, body: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body)
}

type Component = { uid: string; version: string; meta: Record<string, unknown>; jars?: string[] }

/**
 * A Prism data directory with just enough in it to be read.
 *
 * A fixture rather than the machine's real Prism: the assertions are about
 * resolving a classpath from component metadata, and pinning those to whatever
 * one developer happens to have installed makes the test a report on their
 * machine instead of on this code.
 */
async function prism(input: { components: Component[]; template?: string }) {
    const root = await mkdtemp(join(tmpdir(), "axond-prism-"))
    roots.push(root)
    const template = input.template ?? "tmpl"

    await put(join(root, "instances", template, "mmc-pack.json"), JSON.stringify({
        formatVersion: 1,
        components: input.components.map(entry => ({ uid: entry.uid, version: entry.version })),
    }))

    for (const component of input.components) {
        await put(join(root, "meta", component.uid, `${component.version}.json`), JSON.stringify(component.meta))
        for (const jar of component.jars ?? []) await put(join(root, "libraries", jar), "")
    }
    return { root: root, template: template }
}

/** Maven coordinate → the path Prism stores it at, as the fixture writes it. */
function at(coordinate: string): string {
    const [group, name, version, classifier] = coordinate.split(":") as [string, string, string, string | undefined]
    const file = classifier ? `${name}-${version}-${classifier}.jar` : `${name}-${version}.jar`
    return join(...group.split("."), name, version, file)
}

const LWJGL = (version: string): Component => ({
    uid: "org.lwjgl3",
    version: version,
    meta: {
        libraries: [
            { name: `org.lwjgl:lwjgl:${version}` },
            { name: `org.lwjgl:lwjgl-natives-linux:${version}`, rules: [{ action: "allow", os: { name: "linux" } }] },
            { name: `org.lwjgl:lwjgl-natives-windows:${version}`, rules: [{ action: "allow", os: { name: "windows" } }] },
        ],
    },
    jars: [at(`org.lwjgl:lwjgl:${version}`), at(`org.lwjgl:lwjgl-natives-linux:${version}`), at(`org.lwjgl:lwjgl-natives-windows:${version}`)],
})

const MINECRAFT = (version: string): Component => ({
    uid: "net.minecraft",
    version: version,
    meta: {
        mainClass: "net.minecraft.client.main.Main",
        assetIndex: { id: "29" },
        compatibleJavaMajors: [21, 22],
        libraries: [
            { name: "com.google.code.gson:gson:2.11.0" },
            // A CLASSIFIER, the form Minecraft's per-platform natives use.
            { name: "io.netty:netty-transport-native-epoll:4.2.7.Final:linux-x86_64", rules: [{ action: "allow", os: { name: "linux" } }] },
            { name: "io.netty:netty-transport-native-kqueue:4.2.7.Final:osx-x86_64", rules: [{ action: "allow", os: { name: "osx" } }] },
        ],
    },
    jars: [
        at("com.google.code.gson:gson:2.11.0"),
        at("io.netty:netty-transport-native-epoll:4.2.7.Final:linux-x86_64"),
        at("io.netty:netty-transport-native-kqueue:4.2.7.Final:osx-x86_64"),
        join("com", "mojang", "minecraft", version, `minecraft-${version}-client.jar`),
    ],
})

const INTERMEDIARY = (version: string): Component => ({
    uid: "net.fabricmc.intermediary",
    version: version,
    meta: { libraries: [{ name: `net.fabricmc:intermediary:${version}` }] },
    jars: [at(`net.fabricmc:intermediary:${version}`)],
})

const LOADER: Component = {
    uid: "net.fabricmc.fabric-loader",
    version: "0.19.5",
    meta: {
        mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
        libraries: [{ name: "net.fabricmc:fabric-loader:0.19.5" }],
    },
    jars: [at("net.fabricmc:fabric-loader:0.19.5")],
}

const fabric = (minecraft: string, lwjgl: string): Component[] =>
    [LWJGL(lwjgl), MINECRAFT(minecraft), INTERMEDIARY(minecraft), LOADER]

describe("minecraft launch manifest", () => {
    test("reads the versions Prism actually resolved", async () => {
        const { root, template } = await prism({ components: fabric("1.21.11", "3.3.3") })
        const launch = Launch({ prism: root, template: template })

        expect(launch.problem()).toBeNull()
        expect(launch.component("net.minecraft")).toBe("1.21.11")
        expect(launch.component("net.fabricmc.fabric-loader")).toBe("0.19.5")
        expect(launch.component("net.fabricmc.yarn")).toBeNull()
    })

    test("Fabric Loader's main class wins over vanilla's", async () => {
        const { root, template } = await prism({ components: fabric("1.21.11", "3.3.3") })

        expect(Launch({ prism: root, template: template }).manifest().mainClass)
            .toBe("net.fabricmc.loader.impl.launch.knot.KnotClient")
    })

    test("puts the game jar last and leaves other platforms' natives out", async () => {
        const { root, template } = await prism({ components: fabric("1.21.11", "3.3.3") })
        const manifest = Launch({ prism: root, template: template }).manifest()

        // Fabric's loader reads the game jar off the END of the classpath.
        expect(manifest.classpath[manifest.classpath.length - 1]).toContain("minecraft-1.21.11-client.jar")
        expect(manifest.classpath.some(path => path.includes("lwjgl-natives-linux"))).toBe(true)
        expect(manifest.classpath.some(path => path.includes("lwjgl-natives-windows"))).toBe(false)
        expect(manifest.assetIndex).toBe("29")
        expect(manifest.javaMajors).toEqual([21, 22])
    })

    /**
     * A classifier is the fourth part of a coordinate and resolves to
     * `artifact-version-classifier.jar`. Ignoring it silently dropped one jar
     * off a real classpath — the kind of gap that surfaces as a
     * NoClassDefFoundError deep in startup, naming something else.
     */
    test("resolves classifier artifacts, and only this platform's", async () => {
        const { root, template } = await prism({ components: fabric("1.21.11", "3.3.3") })
        const classpath = Launch({ prism: root, template: template }).manifest().classpath

        expect(classpath.some(path => path.endsWith("netty-transport-native-epoll-4.2.7.Final-linux-x86_64.jar"))).toBe(true)
        expect(classpath.some(path => path.includes("kqueue"))).toBe(false)
        expect(classpath.some(path => path.endsWith("netty-transport-native-epoll-4.2.7.Final.jar"))).toBe(false)
    })

    /**
     * The regression this file exists for.
     *
     * The classpath used to be every jar under `libraries/`, which is wrong the
     * moment Prism holds two instances — measured on a real install as 124 jars
     * carrying BOTH LWJGL versions and a 26.3 intermediary on a 1.21.11
     * classpath. Neither is an error the JVM reports.
     */
    test("a Prism holding two Minecrafts yields only this instance's libraries", async () => {
        const { root, template } = await prism({ components: fabric("1.21.11", "3.3.3") })
        // A second instance's artifacts, sitting in the same shared library tree.
        for (const jar of [...(LWJGL("3.4.3").jars ?? []), ...(INTERMEDIARY("26.3").jars ?? [])]) {
            await put(join(root, "libraries", jar), "")
        }

        const classpath = Launch({ prism: root, template: template }).manifest().classpath

        expect(classpath.filter(path => /lwjgl-3\.[0-9.]+\.jar$/.test(path))).toHaveLength(1)
        expect(classpath.some(path => path.includes("3.4.3"))).toBe(false)
        expect(classpath.some(path => path.includes("intermediary-1.21.11"))).toBe(true)
        expect(classpath.some(path => path.includes("intermediary-26.3"))).toBe(false)
    })

    test("names a vanilla instance's missing Fabric rather than launching it", async () => {
        const { root, template } = await prism({ components: [LWJGL("3.3.3"), MINECRAFT("1.21.11")] })
        const launch = Launch({ prism: root, template: template })

        expect(launch.problem()).toContain("no Fabric Loader")
        expect(() => launch.require()).toThrow()
    })

    test("names what is missing rather than launching something that cannot run", async () => {
        const launch = Launch({ prism: join(tmpdir(), "axond-prism-absent"), template: "tmpl" })

        expect(launch.problem()).toContain("no provisioned Minecraft instance")
    })

    test("refuses an instance whose component metadata Prism never downloaded", async () => {
        const { root, template } = await prism({ components: fabric("1.21.11", "3.3.3") })
        await rm(join(root, "meta", "net.minecraft", "1.21.11.json"))

        expect(() => Launch({ prism: root, template: template }).manifest()).toThrow(/no metadata for net\.minecraft/)
    })

    test("refuses when the client jar was never downloaded", async () => {
        const { root, template } = await prism({ components: fabric("1.21.11", "3.3.3") })
        await rm(join(root, "libraries", "com", "mojang", "minecraft", "1.21.11", "minecraft-1.21.11-client.jar"))

        expect(() => Launch({ prism: root, template: template }).manifest()).toThrow(/no Minecraft 1\.21\.11 client jar/)
    })
})

afterAll(async () => {
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
})
