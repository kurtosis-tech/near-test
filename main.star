near_package = import_module("github.com/kurtosis-tech/near-package/main.star")
def run(plan, args):
    near_package_output = near_package.run(plan, args)
    request_recipe = GetHttpRequestRecipe(
        port_id = "http",
        endpoint = "/"
    )
    # ensure that explorer is up and responds
    plan.wait(service_name = "explorer-frontend", recipe = request_recipe, field="code", assertion = "==", target_value = 200, timeout = "60s")
    return near_package_output