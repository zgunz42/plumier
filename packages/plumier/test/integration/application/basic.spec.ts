import { basename } from "path";
import Supertest from "supertest";

import Plumier, { route, WebApiFacility } from "../../../src";

export class AnimalModel {
    constructor(
        public id: number,
        public name: string,
        public age: number
    ) { }
}

//basic controller
export class AnimalController {
    @route.get()
    get(id: number) {
        expect(typeof id).toBe("number")
        return new AnimalModel(id, "Mimi", 5)
    }

    @route.post()
    save(model: AnimalModel) {
        expect(model).toBeInstanceOf(AnimalModel)
        return model
    }

    @route.put()
    modify(id: number, model: AnimalModel) {
        expect(typeof id).toBe("number")
        expect(model).toBeInstanceOf(AnimalModel)
        return { ...model, id }
    }

    @route.delete()
    delete(id: number) {
        expect(typeof id).toBe("number")
        return new AnimalModel(id, "Mimi", 5)
    }
}

function fixture() {
    return new Plumier()
        .set(new WebApiFacility())
        .set({ controller: AnimalController })
        .set({ mode: "production" })
}

describe("Basic Controller", () => {
    it("Should able to perform GET request", async () => {
        const koa = await fixture().initialize()
        await Supertest(koa.callback())
            .get("/animal/get?id=474747")
            .expect(200, { id: 474747, name: 'Mimi', age: 5 })
    })

    it("Should able to perform GET request with case insensitive", async () => {
        const koa = await fixture().initialize()
        await Supertest(koa.callback())
            .get("/animal/get?ID=474747")
            .expect(200, { id: 474747, name: 'Mimi', age: 5 })
    })

    it("Should able to perform POST request", async () => {
        const koa = await fixture().initialize()
        await Supertest(koa.callback())
            .post("/animal/save")
            .send({ id: 474747, name: 'Mimi', age: 5 })
            .expect(200, { id: 474747, name: 'Mimi', age: 5 })
    })

    it("Should able to perform PUT request", async () => {
        const koa = await fixture().initialize()
        await Supertest(koa.callback())
            .put("/animal/modify?id=474747")
            .send({ id: 474747, name: 'Mimi', age: 5 })
            .expect(200, { id: 474747, name: 'Mimi', age: 5 })
    })

    it("Should able to perform PUT request with case insensitive", async () => {
        const koa = await fixture().initialize()
        await Supertest(koa.callback())
            .put("/animal/modify?ID=474747")
            .send({ id: 474747, name: 'Mimi', age: 5 })
            .expect(200, { id: 474747, name: 'Mimi', age: 5 })
    })

    it("Should able to perform DELETE request", async () => {
        const koa = await fixture().initialize()
        await Supertest(koa.callback())
            .delete("/animal/delete?id=474747")
            .expect(200, { id: 474747, name: 'Mimi', age: 5 })
    })

    it("Should able to perform DELETE request with case insensitive", async () => {
        const koa = await fixture().initialize()
        await Supertest(koa.callback())
            .delete("/animal/delete?ID=474747")
            .expect(200, { id: 474747, name: 'Mimi', age: 5 })
    })
})
