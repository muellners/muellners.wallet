import { Module } from 'vuex'
import { AssetAPI, AssetsDict, AssetsState } from '@/store/modules/assets/types'
import {
    IWalletAssetsDict,
    IWalletBalanceDict,
    IWalletNftDict,
    IWalletNftMintDict,
    RootState,
    WalletType,
} from '@/store/types'
import { ava, avm, bintools } from '@/AVA'
import Vue from 'vue'
import AvaAsset from '@/js/AvaAsset'

import { explorer_api } from '@/explorer_api'
import { AvaNftFamily } from '@/js/AvaNftFamily'
import { AmountOutput, UTXOSet as AVMUTXOSet, UTXO as AVMUTXO } from 'avalanche/dist/apis/avm'
import { UnixNow } from 'avalanche/dist/utils'
import BN from 'bn.js'

const assets_module: Module<AssetsState, RootState> = {
    namespaced: true,
    state: {
        AVA_ASSET_ID: null,
        isUpdateBalance: false,
        assets: [],
        assetsDict: {}, // holds meta data of assets
        nftFams: [],
        nftFamsDict: {},
        balanceDict: {},
        nftUTXOs: [],
        nftMintUTXOs: [],
    },
    mutations: {
        addAsset(state, asset: AvaAsset) {
            if (state.assetsDict[asset.id]) {
                // console.info(`Failed to add asset. Asset already exists. (${asset.id})`)
                return
            }
            state.assets.push(asset)
            Vue.set(state.assetsDict, asset.id, asset)
        },
        addNftFamily(state, family: AvaNftFamily) {
            if (state.nftFamsDict[family.id]) {
                // console.info(`Failed to add NFT Family. Asset already exists. (${family.id})`)
                return
            }
            state.nftFams.push(family)
            Vue.set(state.nftFamsDict, family.id, family)
        },
        removeAllAssets(state) {
            state.assets = []
            state.assetsDict = {}
            state.nftFams = []
            state.nftFamsDict = {}
            state.nftUTXOs = []
            state.nftMintUTXOs = []
            state.balanceDict = {}
            state.AVA_ASSET_ID = null
        },
        setIsUpdateBalance(state, val) {
            state.isUpdateBalance = val
        },
    },
    actions: {
        // Called on a logout event
        onlogout({ state, commit }) {
            state.isUpdateBalance = false
            commit('removeAllAssets')
        },

        // Called when the active wallet finishes fetching utxos
        async onUtxosUpdated({ state, dispatch, rootState }) {
            let wallet: WalletType | null = rootState.activeWallet
            if (!wallet) return

            if (wallet.isFetchUtxos) {
                setTimeout(() => {
                    dispatch('onUtxosUpdated')
                }, 500)
                return
            }

            console.log('UTXOs updated.')

            await dispatch('updateBalanceDict')
            await dispatch('updateUtxoArrays')
            await dispatch('addUnknownAssets')
        },

        updateUtxoArrays({ state, rootState, getters }) {
            let utxoSet = getters.walletAvmUtxoSet
            if (utxoSet === null) return {}

            let utxos = utxoSet.getAllUTXOs()

            let nftUtxos = []
            let nftMintUtxos = []

            for (var n = 0; n < utxos.length; n++) {
                let utxo = utxos[n]
                let outId = utxo.getOutput().getOutputID()

                if (outId === 11) {
                    nftUtxos.push(utxo)
                } else if (outId === 10) {
                    nftMintUtxos.push(utxo)
                }
            }

            state.nftUTXOs = nftUtxos
            state.nftMintUTXOs = nftMintUtxos
        },

        // Gets the balances of the active wallet and gets descriptions for unknown asset ids
        addUnknownAssets({ state, getters, rootGetters, dispatch }) {
            // let balanceDict: IWalletBalanceDict = rootGetters.walletBalanceDict
            let balanceDict: IWalletBalanceDict = state.balanceDict
            // let nftDict: IWalletNftDict = rootGetters.walletNftDict
            let nftDict: IWalletNftDict = getters.walletNftDict
            let nftMintDict: IWalletNftMintDict = rootGetters.walletNftMintDict

            for (var id in balanceDict) {
                if (!state.assetsDict[id]) {
                    dispatch('addUnknownAsset', id)
                }
            }

            for (var nft_id in nftDict) {
                if (!state.nftFamsDict[nft_id]) {
                    dispatch('addUnknownNftFamily', nft_id)
                }
            }

            for (var familyId in nftMintDict) {
                if (!state.nftFamsDict[familyId]) {
                    dispatch('addUnknownNftFamily', familyId)
                }
            }
        },

        // Update the utxos for the current active wallet
        async updateUTXOs({ state, commit, dispatch, rootState }) {
            let wallet = rootState.activeWallet
            if (!wallet) {
                return false
            }
            console.log('Update UTXOs')

            commit('setIsUpdateBalance', true)

            // let start = performance.now()
            try {
                await wallet.getUTXOs()
                dispatch('onUtxosUpdated')
                // let now = performance.now()
                // console.log(`getUTXOs: ${now - start}`)
                commit('updateActiveAddress', null, { root: true })
                // dispatch('History/updateTransactionHistory', null, {
                //     root: true,
                // })
                // let now2 = performance.now()
                // console.log(`update history: ${now2 - now}`)
                commit('setIsUpdateBalance', false)
            } catch (e) {
                commit('setIsUpdateBalance', false)
                return false
            }
        },

        // What is the AVA coin in the network
        async updateAvaAsset({ state, commit }) {
            let res = await avm.getAssetDescription('AVAX')
            let id = bintools.cb58Encode(res.assetID)
            state.AVA_ASSET_ID = id
            let asset = new AvaAsset(id, res.name, res.symbol, res.denomination)
            commit('addAsset', asset)
        },

        updateBalanceDict({ state, rootState, getters }): IWalletBalanceDict {
            let utxoSet = getters.walletAvmUtxoSet
            if (utxoSet === null) return {}

            console.log('Update balance dict')
            let dict: IWalletBalanceDict = {}

            let unixNox = UnixNow()
            const ZERO = new BN(0)

            let addrUtxos = utxoSet.getAllUTXOs()
            // console.log(addrUtxos.length)

            for (var n = 0; n < addrUtxos.length; n++) {
                let utxo = addrUtxos[n]

                // Process only SECP256K1 Transfer Output utxos, outputid === 07
                let outId = utxo.getOutput().getOutputID()

                if (outId !== 7) continue

                let utxoOut = utxo.getOutput() as AmountOutput

                let locktime = utxoOut.getLocktime()
                let amount = utxoOut.getAmount()
                let assetIdBuff = utxo.getAssetID()
                let assetId = bintools.cb58Encode(assetIdBuff)

                // if not locked
                if (locktime.lte(unixNox)) {
                    if (!dict[assetId]) {
                        dict[assetId] = {
                            locked: ZERO,
                            available: amount.clone(),
                        }
                    } else {
                        let amt = dict[assetId].available
                        dict[assetId].available = amt.add(amount)
                    }
                } else {
                    // If locked
                    if (!dict[assetId]) {
                        dict[assetId] = {
                            locked: amount.clone(),
                            available: ZERO,
                        }
                    } else {
                        let amt = dict[assetId].locked
                        dict[assetId].locked = amt.add(amount)
                    }
                }
            }
            state.balanceDict = dict
            return dict
        },

        // fetch every asset from the explorer, if explorer exists
        // We can use it later
        // updateAssets({state, rootState, commit}){
        //     //@ts-ignore
        //     let explorerApi = rootState.Network.selectedNetwork.explorerUrl;
        //     if(explorerApi){
        //         explorer_api.get('/x/assets').then(res => {
        //             let assets:AssetAPI[] = res.data.assets;
        //             assets.forEach(asset => {
        //                 let newAsset = new AvaAsset(asset.id, asset.name, asset.symbol, asset.denomination);
        //                 commit('addAsset', newAsset)
        //             });
        //         });
        //     }
        // },

        // Adds an unknown asset id to the assets dictionary
        async addUnknownAsset({ state, commit }, assetId: string) {
            // get info about the asset
            let desc = await ava.XChain().getAssetDescription(assetId)
            let newAsset = new AvaAsset(assetId, desc.name, desc.symbol, desc.denomination)

            await commit('addAsset', newAsset)
            return desc
        },

        async addUnknownNftFamily({ state, commit }, assetId: string) {
            let desc = await ava.XChain().getAssetDescription(assetId)
            let newFam = new AvaNftFamily(assetId, desc.name, desc.symbol)

            await commit('addNftFamily', newFam)
            return desc
        },
    },
    getters: {
        // assset id -> utxos
        walletNftDict(state, getters, rootState) {
            let utxos = state.nftUTXOs
            let res: IWalletNftDict = {}

            console.log('NFT Dict 2')

            for (var i = 0; i < utxos.length; i++) {
                let utxo = utxos[i]
                let assetIdBuff = utxo.getAssetID()
                // TODO: Encoding might be taking too much time
                let assetId = bintools.cb58Encode(assetIdBuff)

                if (res[assetId]) {
                    res[assetId].push(utxo)
                } else {
                    res[assetId] = [utxo]
                }
            }
            return res
        },

        walletAssetsDict(state, getters, rootState, rootGetters): IWalletAssetsDict {
            console.log('Assets Dict 2')

            // let balanceDict: IWalletBalanceDict = getters.walletBalanceDict
            //@ts-ignore
            let balanceDict: IWalletBalanceDict = state.balanceDict
            // @ts-ignore
            let assetsDict: AssetsDict = state.assetsDict
            let res: IWalletAssetsDict = {}

            for (var assetId in assetsDict) {
                let balanceAmt = balanceDict[assetId]

                let asset: AvaAsset
                if (!balanceAmt) {
                    asset = assetsDict[assetId]
                    asset.resetBalance()
                } else {
                    asset = assetsDict[assetId]
                    asset.resetBalance()
                    asset.addBalance(balanceAmt.available)
                    asset.addBalanceLocked(balanceAmt.locked)
                }

                // Add extras for AVAX token
                // @ts-ignore
                if (asset.id === state.AVA_ASSET_ID) {
                    asset.addExtra(rootGetters.walletStakingBalance)
                    asset.addExtra(rootGetters.walletPlatformBalance)
                    asset.addExtra(rootGetters.walletPlatformBalanceLocked)
                    asset.addExtra(rootGetters.walletPlatformBalanceLockedStakeable)
                }

                res[assetId] = asset
            }
            return res
        },

        walletAssetsArray(state, getters): AvaAsset[] {
            // let assetsDict: IWalletAssetsDict = getters.walletAssetsDict
            let assetsDict: IWalletAssetsDict = getters.walletAssetsDict
            let res: AvaAsset[] = []

            for (var id in assetsDict) {
                let asset = assetsDict[id]
                res.push(asset)
            }
            return res
        },

        walletAvmUtxoSet(state, getters, rootState): AVMUTXOSet | null {
            let wallet = rootState.activeWallet
            if (!wallet) return null
            return wallet.utxoset
        },
        nftFamilies(state): AvaNftFamily[] {
            return state.nftFams
        },
        assetIds(state): string[] {
            return state.assets.map((asset) => {
                return asset.id
            })
        },
        AssetAVA(state, getters, rootState, rootGetters): AvaAsset | null {
            let walletBalanceDict = getters.walletAssetsDict
            let AVA_ASSET_ID = state.AVA_ASSET_ID
            if (AVA_ASSET_ID) {
                if (walletBalanceDict[AVA_ASSET_ID]) {
                    return walletBalanceDict[AVA_ASSET_ID]
                }
            }
            return null
        },
    },
}

export default assets_module
