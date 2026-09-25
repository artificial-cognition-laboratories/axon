import { AxonCloud } from "../../../src"
import { TEST_USER } from "../setup/user"
import { backendUrl } from "../setup/staging"

const baseUrl = backendUrl()

describe("billing.portal", () => {
    it("returns a real Stripe-hosted portal URL", async () => {
        const cloud = AxonCloud({ baseUrl, key: TEST_USER.apiKey })

        const portal = await cloud.user.billing.portal()

        expect(portal.url).toContain("http")
    })

})
