"use client";

import { NETWORKS, type NetworkKey } from "@/config/networks";
import { useNetworkReadiness } from "@/components/hooks";
import { CheckList, LoadingRows, Spinner } from "@/components/ui";

/** Runs the same onchain verification the app uses before allowing payments. */
export function LiveContractCheck({ networkKey }: { networkKey: NetworkKey }) {
  const network = NETWORKS[networkKey];
  const { data, isLoading, error, refetch, isFetching } = useNetworkReadiness(network);

  return (
    <div className="rounded-xl border border-harbor p-4">
      <p className="mb-3 text-sm font-medium text-snow">Checked onchain just now</p>
      {isLoading ? (
        <LoadingRows label={`Reading contracts from ${network.label}`} rows={2} />
      ) : error ? (
        <p className="text-sm text-bad">Could not reach the network: {error.message.split("\n")[0]}</p>
      ) : (
        <CheckList
          checks={[
            data?.token
              ? {
                  id: "token",
                  label: `Token found: ${data.token.name} (${data.token.symbol}), ${data.token.decimals} decimals`,
                  status: data.token.isMock ? "warn" : "ok",
                  detail: data.token.isMock ? "Test token with no value." : undefined,
                }
              : { id: "token", label: "Token", status: "fail", detail: data?.tokenError },
            data?.announcer
              ? { id: "announcer", label: "Announcer bytecode matches QuietPay's build", status: "ok" }
              : { id: "announcer", label: "Announcer", status: "fail", detail: data?.announcerError },
          ]}
        />
      )}
      {!isLoading && (
        <button type="button" className="btn btn-sm btn-quiet mt-4" onClick={() => refetch()} disabled={isFetching}>
          {isFetching ? <Spinner /> : null} Check again
        </button>
      )}
    </div>
  );
}
