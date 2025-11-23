/* eslint-env node */

import { ConsoleRemotePlugin } from '@openshift-console/dynamic-plugin-sdk-webpack';
import * as path from 'path';
import * as webpack from 'webpack';

const config: any = {
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    context: path.resolve(__dirname, 'src'),
    entry: './index.tsx',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: '[name]-bundle.js',
        chunkFilename: '[name]-chunk.js',
    },
    resolve: {
        extensions: ['.ts', '.tsx', '.js', '.jsx'],
    },
    module: {
        rules: [
            {
                test: /(\.jsx?)|(\.tsx?)$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: 'ts-loader',
                        options: {
                            configFile: path.resolve(__dirname, 'tsconfig.json'),
                        },
                    },
                ],
            },
            {
                test: /\.css$/,
                use: ['style-loader', 'css-loader'],
            },
            {
                test: /\.(png|jpg|jpeg|gif|svg|woff2?|ttf|eot|otf)(\?.*$|$)/,
                type: 'asset/resource',
            },
        ],
    },
    plugins: [
        new ConsoleRemotePlugin(),
    ],
    devtool: 'source-map',
    optimization: {
        chunkIds: 'named',
        minimize: false,
    },
    devServer: {
        port: 9001,
        allowedHosts: 'all',
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
            "Access-Control-Allow-Headers": "X-Requested-With, Content-Type, Authorization"
        },
    },
};

if (process.env.NODE_ENV === 'production') {
    config.mode = 'production';
    if (config.output) {
        config.output.filename = '[name]-bundle-[contenthash].min.js';
        config.output.chunkFilename = '[name]-chunk-[contenthash].min.js';
    }
    if (config.optimization) {
        config.optimization.minimize = true;
    }
}

export default config;
