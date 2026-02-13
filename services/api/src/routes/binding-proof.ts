import { FastifyPluginAsync } from 'fastify';
import { submitBindingProofSchema } from '@mirrormarkets/shared';
import {
  buildBindingMessage,
  hashBindingProof,
} from '@mirrormarkets/shared';
import { AppError, ErrorCodes } from '@mirrormarkets/shared';
import { verifyMessage } from 'ethers';

/**
 * Binding Proof routes
 *
 * The binding proof establishes the cryptographic link between the user's
 * embedded wallet (client-side, owned by user) and their server wallet
 * (MPC-backed, controlled by backend). On first login after provisioning,
 * the frontend signs a binding message with the embedded wallet. This
 * endpoint verifies the signature and stores the proof.
 *
 * POST /binding-proof  — submit a binding proof
 * GET  /binding-proof  — check if user has a binding proof
 */
export const bindingProofRoutes: FastifyPluginAsync = async (app) => {
  // POST /binding-proof — submit a new binding proof
  app.post<{
    Body: {
      embeddedWalletAddress: string;
      serverWalletAddress: string;
      nonce: string;
      timestamp: number;
      signature: string;
    };
  }>('/', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['embeddedWalletAddress', 'serverWalletAddress', 'nonce', 'timestamp', 'signature'],
        properties: {
          embeddedWalletAddress: { type: 'string' },
          serverWalletAddress: { type: 'string' },
          nonce: { type: 'string' },
          timestamp: { type: 'number' },
          signature: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = request.userId!;
    const parsed = submitBindingProofSchema.parse(request.body);

    // Check if binding proof already exists
    const existing = await app.prisma.bindingProof.findUnique({
      where: { userId },
    });
    if (existing) {
      return reply.status(200).send({
        id: existing.id,
        embeddedWalletAddr: existing.embeddedWalletAddr,
        proofHash: existing.proofHash,
        verifiedAt: existing.verifiedAt.toISOString(),
        createdAt: existing.createdAt.toISOString(),
      });
    }

    // Verify the server wallet address matches the user's actual server wallet
    const serverWallet = await app.prisma.serverWallet.findUnique({
      where: { userId },
    });
    if (!serverWallet || serverWallet.status !== 'READY') {
      throw new AppError(
        ErrorCodes.SERVER_WALLET_NOT_READY,
        'Server wallet must be provisioned before binding proof',
        400,
      );
    }
    if (serverWallet.address.toLowerCase() !== parsed.serverWalletAddress.toLowerCase()) {
      throw new AppError(
        ErrorCodes.BINDING_PROOF_INVALID,
        'Server wallet address does not match',
        400,
      );
    }

    // Verify timestamp is recent (within 5 minutes)
    const fiveMinutesMs = 5 * 60 * 1000;
    if (Math.abs(Date.now() - parsed.timestamp) > fiveMinutesMs) {
      throw new AppError(
        ErrorCodes.BINDING_PROOF_INVALID,
        'Binding proof timestamp is too old or too far in the future',
        400,
      );
    }

    // Reconstruct the binding message and verify the signature
    const message = buildBindingMessage(
      parsed.embeddedWalletAddress,
      parsed.serverWalletAddress,
      parsed.nonce,
      parsed.timestamp,
    );

    try {
      const recoveredAddress = verifyMessage(message, parsed.signature);
      if (recoveredAddress.toLowerCase() !== parsed.embeddedWalletAddress.toLowerCase()) {
        throw new AppError(
          ErrorCodes.BINDING_PROOF_INVALID,
          'Signature does not match embedded wallet address',
          400,
        );
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        ErrorCodes.BINDING_PROOF_INVALID,
        'Invalid signature',
        400,
      );
    }

    // Store the binding proof
    const proofHash = hashBindingProof(message, parsed.signature);
    const proof = await app.prisma.bindingProof.create({
      data: {
        userId,
        embeddedWalletAddr: parsed.embeddedWalletAddress,
        proofHash,
        verifiedAt: new Date(),
      },
    });

    await app.prisma.auditLog.create({
      data: {
        userId,
        action: 'BINDING_PROOF_CREATED',
        details: {
          embeddedWalletAddr: parsed.embeddedWalletAddress,
          serverWalletAddr: parsed.serverWalletAddress,
          proofHash,
        },
      },
    });

    return reply.status(201).send({
      id: proof.id,
      embeddedWalletAddr: proof.embeddedWalletAddr,
      proofHash: proof.proofHash,
      verifiedAt: proof.verifiedAt.toISOString(),
      createdAt: proof.createdAt.toISOString(),
    });
  });

  // GET /binding-proof — check if user has a binding proof
  app.get('/', {
    preHandler: [app.authenticate],
  }, async (request, reply) => {
    const userId = request.userId!;

    const proof = await app.prisma.bindingProof.findUnique({
      where: { userId },
    });

    if (!proof) {
      return reply.status(404).send({
        code: ErrorCodes.NOT_FOUND,
        message: 'No binding proof found',
      });
    }

    return reply.send({
      id: proof.id,
      embeddedWalletAddr: proof.embeddedWalletAddr,
      proofHash: proof.proofHash,
      verifiedAt: proof.verifiedAt.toISOString(),
      createdAt: proof.createdAt.toISOString(),
    });
  });
};
