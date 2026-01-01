# Troubleshooting

Assuming these values below:

```bash
export APP_NAME='ovn-recon'
export APP_NAMESPACE='ovn-recon'
export APP_SELECTOR="app.kubernetes.io/name=$APP_NAME"
```

If the plugin does not appear in the console:

1.  **Check the Plugin Pod:**
    Ensure the plugin pod is running and ready:
    ```bash
    oc get pods -l "$APP_SELECTOR" -n "$APP_NAMESPACE"
    ```

2.  **Verify Manifest Availability:**
    Check if the plugin manifest is being served correctly:
    ```bash
    oc exec -n $APP_NAMESPACE deployment/$APP_NAME -- \
        curl -sk https://localhost:9443/plugin-manifest.json | jq
    ```

3.  **Check ConsolePlugin Status:**
    See if the Console Operator has successfully registered the plugin:
    ```bash
    oc get consoleplugin ovn-recon -o yaml
    ```
    Look for the `Available` condition.

4.  **Restart the Console:**
    Sometimes the Console needs to be restarted to pick up new plugins:
    ```bash
    oc rollout restart deployment/console -n openshift-console
    ```

    > [!IMPORTANT]
    > Ensure your `consoleplugin.yaml` uses `apiVersion: console.openshift.io/v1`. The older `v1alpha1` API may cause the `backend` field to be dropped, preventing the plugin from loading.
    >
    > Also, ensure that the `section` ID in `console-extensions.json` matches the internal ID of the section (e.g., "home" instead of "Home").
