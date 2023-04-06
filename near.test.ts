import {EnclaveContext, EnclaveUUID, KurtosisContext} from "kurtosis-sdk"
import log from "loglevel"
import {err, ok, Result} from "neverthrow"
import {PortSpec} from "kurtosis-sdk/build/core/lib/services/port_spec";
import {StarlarkRunResult} from "kurtosis-sdk/build/core/lib/enclaves/starlark_run_blocking";
import {ServiceContext} from "kurtosis-sdk/build/core/lib/services/service_context";
import fetch from "node-fetch";
import * as http from "http";

const TEST_NAME = "near-packge-test";
const MILLISECONDS_IN_SECOND = 1000;
const IS_PARTITIONING_ENABLED = false;
const EMPTY_PACKAGE_PARAMS = "{}"
const IS_NOT_DRY_RUN = false

const STARLARK_SCRIPT_CALLING_NEAR_PACKAGE = `
near_package = import_module("github.com/kurtosis-tech/near-package/main.star")
def run(plan, args):
    near_package_output = near_package.run(plan, args)
    return output
`

// TODO use constants from a library maybe
const HTTP_CREATED = 201
const HTTP_OK = 200

jest.setTimeout(180000)

/*
This example will:
1. Spin up a near package via composition
2. Make assertions on the state of the forntend
*/
test("Test NEAR package", async () => {

    // ------------------------------------- ENGINE SETUP ----------------------------------------------
    log.info("Creating the enclave")
    const createEnclaveResult = await createEnclave(TEST_NAME, IS_PARTITIONING_ENABLED)

    if (createEnclaveResult.isErr()) {
        throw createEnclaveResult.error
    }

    const {enclaveContext, destroyEnclaveFunction} = createEnclaveResult.value

    try {
        // ------------------------------------- PACKAGE RUN ----------------------------------------------
        log.info("------------ EXECUTING PACKAGE ---------------")

        const runResult: Result<StarlarkRunResult, Error> = await enclaveContext.()

        if (runResult.isErr()) {
            log.error(`An error occurred execute Starlark script '${STARLARK_SCRIPT_CALLING_NEAR_PACKAGE}'`);
            throw runResult.error
        }

        expect(runResult.value.interpretationError).toBeUndefined();
        expect(runResult.value.validationErrors).toEqual([]);
        expect(runResult.value.executionError).toBeUndefined();

        log.info("------------ EXECUTING TEST ---------------")

        const getApiServiceContextResult: Result<ServiceContext, Error> = await enclaveContext.getServiceContext(API_SERVICE_NAME);
        if (getApiServiceContextResult.isErr()) {
            log.error("An error occurred getting the API service context");
            throw getApiServiceContextResult.error;
        }
        const apiServiceContext: ServiceContext = getApiServiceContextResult.value;
        const apiServicePublicPorts: Map<string, PortSpec> = await apiServiceContext.getPublicPorts();
        if (apiServicePublicPorts.size == 0){
            throw new Error("Expected to receive API service public ports but none was received")
        }

        if (!apiServicePublicPorts.has(HTTP_PORT_ID)){
            throw new Error(`Expected to find API service port wih ID ${HTTP_PORT_ID} but it was not found`)
        }

        const apiServiceHttpPortSpec: PortSpec = apiServicePublicPorts.get(HTTP_PORT_ID)!
        const apiServiceHttpPort: number = apiServiceHttpPortSpec.number
        const apiServicePublicIpAddress: string = apiServiceContext.getMaybePublicIPAddress()

        const apiAddress = `http://${apiServicePublicIpAddress}:${apiServiceHttpPort}`
        const apiAddressWithActorEndpoint = apiAddress + "/actor"

        const kevinActor: Actor = new Actor(
            "Kevin",
            "Bacon"
        )

        const steveBuscemiActor = new Actor(
            "Steve",
            "Buscemi",
        )

        const randomNewActor = new Actor(
            "ThisFirstNameIsntInDB",
            "ThisLastNameIsntInDB"
        )

        const actors = Array.from([kevinActor, steveBuscemiActor, randomNewActor])

        // send a post request
        log.info("Testing API by sending POST requests")
        const postResponse = await fetch(
            apiAddressWithActorEndpoint, {
                method: "POST",
                headers: {
                    "content-type": CONTENT_TYPE,
                },
                body: JSON.stringify(actors)
            }
        )
        expect(postResponse.status).toEqual(HTTP_CREATED)


        // send a get request
        log.info("Testing API by sending GET requests")
        const getResponse = await fetch(
            apiAddressWithActorEndpoint, {
                method: "GET",
            }
        )
        expect(getResponse.status).toEqual(HTTP_OK)
        const jsonResponseObjectList = await getResponse.json()
        // TODO fix how we deserialize here with something less hacky
        const actorsList:Actor[] = jsonResponseObjectList.map(x => new Actor(x.first_name, x.last_name))
        expect(actorsList.length).toBeGreaterThan(3)
        expect(actorsList).toContainEqual(kevinActor)
        expect(actorsList).toContainEqual(steveBuscemiActor)
        expect(actorsList).toContainEqual(randomNewActor)

        log.info("Test finished successfully")
    } finally {
        destroyEnclaveFunction()
    }
})

async function createEnclave(testName: string, isPartitioningEnabled: boolean):
    Promise<Result<{
        enclaveContext: EnclaveContext,
        destroyEnclaveFunction: () => Promise<Result<null, Error>>,
    }, Error>> {

    const newKurtosisContextResult = await KurtosisContext.newKurtosisContextFromLocalEngine()
    if (newKurtosisContextResult.isErr()) {
        log.error(`An error occurred connecting to the Kurtosis engine for running test ${testName}`)
        return err(newKurtosisContextResult.error)
    }
    const kurtosisContext = newKurtosisContextResult.value;

    const enclaveName: EnclaveUUID = `${testName}.${Math.round(Date.now() / MILLISECONDS_IN_SECOND)}`
    const createEnclaveResult = await kurtosisContext.createEnclave(enclaveName, isPartitioningEnabled);

    if (createEnclaveResult.isErr()) {
        log.error(`An error occurred creating enclave ${enclaveName}`)
        return err(createEnclaveResult.error)
    }

    const enclaveContext = createEnclaveResult.value;

    const destroyEnclaveFunction = async (): Promise<Result<null, Error>> => {
        const destroyEnclaveResult = await kurtosisContext.destroyEnclave(enclaveName)
        if (destroyEnclaveResult.isErr()) {
            const errMsg = `An error occurred destroying enclave ${enclaveName} that we created for this test: ${destroyEnclaveResult.error.message}`
            log.error(errMsg)
            log.error(`ACTION REQUIRED: You'll need to destroy enclave ${enclaveName} manually!!!!`)
            return err(new Error(errMsg))
        }
        return ok(null)
    }

    return ok({enclaveContext, destroyEnclaveFunction})
}

